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

export interface PublishBlueskyInput {
  request: PublishRequest;
  identifier: string;
  appPassword: string;
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

async function createSession(
  service: string,
  identifier: string,
  password: string,
): Promise<{ ok: true; session: BlueskySession } | { ok: false; status: number; detail: string }> {
  let resp: Response;
  try {
    resp = await fetch(`${service}/xrpc/com.atproto.server.createSession`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier, password }),
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      detail: err instanceof Error ? err.message : "network error",
    };
  }
  if (resp.status === 401) {
    return {
      ok: false,
      status: 401,
      detail: "Bluesky rejected the identifier/app-password.",
    };
  }
  if (!resp.ok) {
    return {
      ok: false,
      status: resp.status,
      detail: `createSession returned ${resp.status}`,
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
    };
  }
  if (!json.accessJwt || !json.did) {
    return {
      ok: false,
      status: resp.status,
      detail: "createSession response missing accessJwt or did",
    };
  }
  return { ok: true, session: { accessJwt: json.accessJwt, did: json.did } };
}

async function createPostRecord(
  service: string,
  session: BlueskySession,
  record: Record<string, unknown>,
): Promise<{ ok: true; record: CreateRecordResponse } | { ok: false; status: number; detail: string }> {
  let resp: Response;
  try {
    resp = await fetch(`${service}/xrpc/com.atproto.repo.createRecord`, {
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
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      detail: err instanceof Error ? err.message : "network error",
    };
  }
  if (resp.status === 401 || resp.status === 403) {
    return {
      ok: false,
      status: resp.status,
      detail: `Bluesky returned ${resp.status} — session may have been revoked.`,
    };
  }
  if (resp.status === 429) {
    return { ok: false, status: 429, detail: "Bluesky returned 429" };
  }
  if (!resp.ok) {
    return {
      ok: false,
      status: resp.status,
      detail: `createRecord returned ${resp.status}`,
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
    };
  }
  if (!json.uri || !json.cid) {
    return {
      ok: false,
      status: resp.status,
      detail: "createRecord response missing uri or cid",
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
    const record: Record<string, unknown> = {
      $type: "app.bsky.feed.post",
      text: part.text,
      createdAt,
      langs: ["en"],
    };
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
        thread_position_failed: thread.indexOf(part) + 1,
        thread_total: thread.length,
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
