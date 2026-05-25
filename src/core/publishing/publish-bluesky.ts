import "server-only";
/**
 * Phase F4 — Bluesky publisher (AT Protocol).
 *
 * Bluesky requires session authentication via `com.atproto.server.createSession`,
 * then post records are created with `com.atproto.repo.createRecord` against
 * the collection `app.bsky.feed.post`.
 *
 * We do NOT use @atproto/api — it's a heavy SDK with its own auth lifecycle.
 * Plain fetch against documented endpoints is enough for the publish-only flow.
 *
 * Reference:
 *   - https://docs.bsky.app/docs/api/com-atproto-server-create-session
 *   - https://docs.bsky.app/docs/api/com-atproto-repo-create-record
 *
 * Threading:
 *   - first post: no reply ref
 *   - subsequent posts: reply.root = first, reply.parent = previous
 *
 * NEVER:
 *   - persists the access JWT (it lives only in the closure of one publish call)
 *   - logs the app password
 *   - retries automatically
 */

import { publishFail, publishOk } from "./publishing-result";
import type { PublishOutcome, PublishRequest } from "./publishing-types";
import { canonicalPostFromRequest } from "./canonical-post";
import { transformForBluesky } from "./transformers/bluesky";
import { fetchWithTimeout, isTimeoutError } from "./fetch-with-timeout";
import { extractFacets } from "./transformers/bluesky-facets";
import {
  formatBlueskyReasonDetail,
  readBlueskyErrorBody,
  type BlueskyErrorBody,
} from "./atproto-error-body";

export interface PublishBlueskyInput {
  request: PublishRequest;
  identifier: string;
  appPassword: string;
  service: string;
}

/**
 * Identity-scoped publish input. The caller provides an already-
 * decrypted access JWT + the DID this session belongs to. The
 * publisher uses these directly — no createSession round-trip, no
 * app password handling.
 *
 * The caller (the runner) is responsible for refresh-on-401:
 * `session_expired` is returned as a typed outcome so the runner can
 * orchestrate refresh + retry exactly once. The publisher itself
 * never retries.
 */
export interface PublishBlueskyAsIdentityInput {
  request: PublishRequest;
  /** Decrypted access JWT. Held only in this call's scope. */
  accessJwt: string;
  /** The DID that owns the session (= repo for createRecord). */
  did: string;
  /** The canonical handle for this identity. Drives the permalink. */
  handle: string;
  /** AT Protocol PDS service URL, e.g. https://bsky.social */
  service: string;
}

interface BlueskySession {
  accessJwt: string;
  did: string;
}

interface CreateRecordResponse {
  uri: string;
  cid: string;
}

interface SessionFailure {
  ok: false;
  status: number;
  detail: string;
  /** Structured AT Proto error captured from the response body.
   *  Null when the failure happened before we received a response
   *  (network / timeout) or when the body was empty. */
  errorBody: BlueskyErrorBody | null;
}

async function createSession(
  service: string,
  identifier: string,
  password: string,
): Promise<{ ok: true; session: BlueskySession } | SessionFailure> {
  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      `${service}/xrpc/com.atproto.server.createSession`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, password }),
        timeoutMs: 15_000,
      },
    );
  } catch (err) {
    if (isTimeoutError(err)) {
      return {
        ok: false,
        status: 0,
        detail: "Bluesky login timed out (15s).",
        errorBody: null,
      };
    }
    return {
      ok: false,
      status: 0,
      detail: err instanceof Error ? err.message : "network error",
      errorBody: null,
    };
  }
  if (resp.status === 401) {
    const errorBody = await readBlueskyErrorBody(resp);
    return {
      ok: false,
      status: 401,
      detail:
        errorBody.atproto_error || errorBody.atproto_message
          ? formatBlueskyReasonDetail("createSession", 401, errorBody)
          : "Bluesky rejected the identifier/app-password.",
      errorBody,
    };
  }
  if (!resp.ok) {
    const errorBody = await readBlueskyErrorBody(resp);
    return {
      ok: false,
      status: resp.status,
      detail: formatBlueskyReasonDetail("createSession", resp.status, errorBody),
      errorBody,
    };
  }
  let json: { accessJwt?: string; did?: string };
  try {
    json = (await resp.json()) as { accessJwt?: string; did?: string };
  } catch {
    return {
      ok: false,
      status: resp.status,
      detail: "createSession response was not JSON",
      errorBody: null,
    };
  }
  if (!json.accessJwt || !json.did) {
    return {
      ok: false,
      status: resp.status,
      detail: "createSession response missing accessJwt or did",
      errorBody: null,
    };
  }
  return { ok: true, session: { accessJwt: json.accessJwt, did: json.did } };
}

interface CreateRecordFailure {
  ok: false;
  status: number;
  detail: string;
  /** Structured AT Proto error captured from the response body.
   *  Null when the failure happened before we received a response
   *  (network / timeout) or when the body was empty / unreadable. */
  errorBody: BlueskyErrorBody | null;
}

async function createPostRecord(
  service: string,
  session: BlueskySession,
  record: Record<string, unknown>,
): Promise<{ ok: true; record: CreateRecordResponse } | CreateRecordFailure> {
  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      `${service}/xrpc/com.atproto.repo.createRecord`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.accessJwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          repo: session.did,
          collection: "app.bsky.feed.post",
          record,
        }),
        timeoutMs: 20_000,
      },
    );
  } catch (err) {
    if (isTimeoutError(err)) {
      return {
        ok: false,
        status: 0,
        detail: "Bluesky didn't respond in time (20s).",
        errorBody: null,
      };
    }
    return {
      ok: false,
      status: 0,
      detail: err instanceof Error ? err.message : "network error",
      errorBody: null,
    };
  }
  if (resp.status === 401 || resp.status === 403) {
    const errorBody = await readBlueskyErrorBody(resp);
    return {
      ok: false,
      status: resp.status,
      detail:
        errorBody.atproto_error || errorBody.atproto_message
          ? formatBlueskyReasonDetail("createRecord", resp.status, errorBody)
          : `Bluesky returned ${resp.status} — session may have been revoked.`,
      errorBody,
    };
  }
  if (resp.status === 429) {
    const errorBody = await readBlueskyErrorBody(resp);
    return {
      ok: false,
      status: 429,
      detail:
        errorBody.atproto_error || errorBody.atproto_message
          ? formatBlueskyReasonDetail("createRecord", 429, errorBody)
          : "Bluesky returned 429",
      errorBody,
    };
  }
  if (!resp.ok) {
    const errorBody = await readBlueskyErrorBody(resp);
    return {
      ok: false,
      status: resp.status,
      detail: formatBlueskyReasonDetail("createRecord", resp.status, errorBody),
      errorBody,
    };
  }
  let json: { uri?: string; cid?: string };
  try {
    json = (await resp.json()) as { uri?: string; cid?: string };
  } catch {
    return {
      ok: false,
      status: resp.status,
      detail: "createRecord response was not JSON",
      errorBody: null,
    };
  }
  if (!json.uri || !json.cid) {
    return {
      ok: false,
      status: resp.status,
      detail: "createRecord response missing uri or cid",
      errorBody: null,
    };
  }
  return { ok: true, record: { uri: json.uri, cid: json.cid } };
}

/**
 * Convert an at-uri (at://<did>/app.bsky.feed.post/<rkey>) to a
 * bsky.app permalink. Bluesky doesn't return a permalink directly,
 * so we synthesize one.
 */
function atUriToBskyPermalink(uri: string, handle: string): string | null {
  const m = uri.match(/^at:\/\/[^/]+\/app\.bsky\.feed\.post\/([A-Za-z0-9]+)$/);
  if (!m) return null;
  const rkey = m[1];
  return `https://bsky.app/profile/${handle}/post/${rkey}`;
}

export async function publishToBluesky(
  input: PublishBlueskyInput,
): Promise<PublishOutcome> {
  const { request, identifier, appPassword, service } = input;

  if (!identifier || !appPassword) {
    return publishFail(
      "missing_identifier",
      "Bluesky: set BLUESKY_IDENTIFIER and BLUESKY_APP_PASSWORD.",
    );
  }
  if (!request.body || request.body.trim().length === 0) {
    return publishFail("missing_body", "Bluesky posts need body text.");
  }

  // 1. Create a session.
  const sessionResult = await createSession(service, identifier, appPassword);
  if (!sessionResult.ok) {
    const code =
      sessionResult.status === 401
        ? "platform_unauthorized"
        : "platform_api_error";
    return publishFail(code, `Bluesky: ${sessionResult.detail}`, {
      http_status: sessionResult.status,
      endpoint: "createSession",
      ...errorBodyMetadata(sessionResult.errorBody),
    });
  }
  const { session } = sessionResult;

  // 2. Transform canonical post into a thread of Bluesky posts.
  const post = canonicalPostFromRequest(request);
  const thread = transformForBluesky(post);
  if (thread.length === 0) {
    return publishFail("missing_body", "Bluesky thread had no content.");
  }

  // 3. Publish the thread, threading reply references.
  let rootUri: string | null = null;
  let rootCid: string | null = null;
  let previousUri: string | null = null;
  let previousCid: string | null = null;
  const createdAt = new Date().toISOString();

  for (const part of thread) {
    const facets = extractFacets(part.text);
    const record: Record<string, unknown> = {
      $type: "app.bsky.feed.post",
      text: part.text,
      createdAt,
      langs: ["en"],
    };
    if (facets.length > 0) {
      record.facets = facets;
    }
    if (rootUri && rootCid && previousUri && previousCid) {
      record.reply = {
        root: { uri: rootUri, cid: rootCid },
        parent: { uri: previousUri, cid: previousCid },
      };
    }
    const result = await createPostRecord(service, session, record);
    if (!result.ok) {
      const code =
        result.status === 429
          ? "platform_rate_limited"
          : result.status === 401 || result.status === 403
            ? "platform_unauthorized"
            : "platform_api_error";
      return publishFail(code, `Bluesky: ${result.detail}`, {
        http_status: result.status,
        endpoint: "createRecord",
        thread_position_failed: thread.indexOf(part) + 1,
        thread_total: thread.length,
        ...errorBodyMetadata(result.errorBody),
      });
    }
    if (!rootUri) {
      rootUri = result.record.uri;
      rootCid = result.record.cid;
    }
    previousUri = result.record.uri;
    previousCid = result.record.cid;
  }

  // 4. Synthesize the permalink for the root post.
  const handle = identifier.includes(".") ? identifier : null;
  const permalink =
    rootUri && handle ? atUriToBskyPermalink(rootUri, handle) : null;

  return publishOk({
    externalId: rootUri,
    externalUrl: permalink,
    metadata: {
      thread_length: thread.length,
      root_uri: rootUri,
    },
  });
}

// =====================================================================
// Identity-scoped publish — the correct model.
// =====================================================================
//
// publishToBlueskyAsIdentity uses the encrypted session already
// owned by THIS identity (via /api/identity/[id]/bluesky/connect),
// never the workspace-level BLUESKY_APP_PASSWORD. The runner
// decrypts the access JWT, calls this function, and on 401 handles
// refresh + retry orchestration externally.
//
// The function is pure (modulo fetch) and identity-scoped:
//   - repo = input.did      → posts always land on this identity's account
//   - Authorization Bearer  → uses this identity's session only
// Two identities passing two different (did, accessJwt) values can
// NEVER cross-pollinate — the function reads only what was passed in.

/**
 * Publishes the canonical post under the given identity's session.
 *
 * Returns one of three outcomes via the standard PublishOutcome:
 *   - ok: publish succeeded
 *   - fail("session_expired", ...): server returned 401. The runner
 *     should attempt refresh exactly once.
 *   - other failure codes: rate-limited, network, malformed input
 */
export async function publishToBlueskyAsIdentity(
  input: PublishBlueskyAsIdentityInput,
): Promise<PublishOutcome> {
  const { request, accessJwt, did, handle, service } = input;

  if (!accessJwt || !did) {
    return publishFail(
      "session_missing",
      "Bluesky: identity is not signed in.",
    );
  }
  if (!request.body || request.body.trim().length === 0) {
    return publishFail("missing_body", "Bluesky posts need body text.");
  }

  // Transform canonical post into a thread of Bluesky posts.
  const post = canonicalPostFromRequest(request);
  const thread = transformForBluesky(post);
  if (thread.length === 0) {
    return publishFail("missing_body", "Bluesky thread had no content.");
  }

  const session: BlueskySession = { accessJwt, did };
  const createdAt = new Date().toISOString();
  let rootUri: string | null = null;
  let rootCid: string | null = null;
  let previousUri: string | null = null;
  let previousCid: string | null = null;

  for (const part of thread) {
    const facets = extractFacets(part.text);
    const record: Record<string, unknown> = {
      $type: "app.bsky.feed.post",
      text: part.text,
      createdAt,
      langs: ["en"],
    };
    if (facets.length > 0) record.facets = facets;
    if (rootUri && rootCid && previousUri && previousCid) {
      record.reply = {
        root: { uri: rootUri, cid: rootCid },
        parent: { uri: previousUri, cid: previousCid },
      };
    }
    const result = await createPostRecord(service, session, record);
    if (!result.ok) {
      // 401 → typed session_expired so the runner can attempt a
      // refresh exactly once. 403 stays generic — refresh won't
      // help if the account itself was banned/disabled.
      const code =
        result.status === 401
          ? "session_expired"
          : result.status === 429
            ? "platform_rate_limited"
            : result.status === 403
              ? "platform_unauthorized"
              : "platform_api_error";
      return publishFail(code, `Bluesky: ${result.detail}`, {
        http_status: result.status,
        endpoint: "createRecord",
        thread_position_failed: thread.indexOf(part) + 1,
        thread_total: thread.length,
        // The DID is public information — already in the at-uri of
        // any of this identity's published posts. Including it in
        // diagnostic metadata is safe.
        did,
        ...errorBodyMetadata(result.errorBody),
      });
    }
    if (!rootUri) {
      rootUri = result.record.uri;
      rootCid = result.record.cid;
    }
    previousUri = result.record.uri;
    previousCid = result.record.cid;
  }

  const permalink = rootUri ? atUriToBskyPermalink(rootUri, handle) : null;

  return publishOk({
    externalId: rootUri,
    externalUrl: permalink,
    metadata: {
      thread_length: thread.length,
      root_uri: rootUri,
      // No tokens, no app passwords. DID is public and useful for
      // operator audit ("which exact account did this post under?").
      did,
    },
  });
}

/**
 * Flatten the structured `BlueskyErrorBody` into the keys we want to
 * land in PublishOutcome.metadata. Returns an empty object when the
 * body was null (network/timeout) so the spread is a no-op.
 *
 * Output keys (all optional):
 *   - atproto_error
 *   - atproto_message
 *   - atproto_response_body_truncated
 *   - atproto_response_body_was_truncated
 */
function errorBodyMetadata(
  body: BlueskyErrorBody | null,
): Record<string, unknown> {
  if (!body) return {};
  return {
    atproto_error: body.atproto_error,
    atproto_message: body.atproto_message,
    atproto_response_body_truncated: body.atproto_response_body_truncated,
    atproto_response_body_was_truncated: body.atproto_response_body_was_truncated,
  };
}
