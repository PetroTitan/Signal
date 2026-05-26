import "server-only";
/**
 * Phase F8 — Hashnode publisher (identity-scoped).
 *
 * Hashnode publishes via GraphQL at https://gql.hashnode.com/. The
 * relevant operation is `publishPost(input: PublishPostInput!)`.
 *
 * Reference: https://apidocs.hashnode.com/#mutation-publishPost
 *
 * Authentication: `Authorization: <HASHNODE_API_KEY>` header (the
 * raw token, NOT `Bearer <token>`).
 *
 * Reason-code policy
 * ------------------
 * Every refusal / failure produces a Hashnode-prefixed reason code so
 * the operator-facing copy stays actionable:
 *
 *   - hashnode_token_missing        — no api key for this identity
 *   - hashnode_token_invalid        — 401/403 from the GraphQL gateway
 *                                     OR a GraphQL `errors[]` entry
 *                                     whose extensions.code looks
 *                                     auth-related (UNAUTHENTICATED /
 *                                     FORBIDDEN / token/unauth match
 *                                     on the message)
 *   - hashnode_publication_missing  — caller passed an empty publication id
 *   - hashnode_title_required       — request has no title
 *   - hashnode_body_required        — request has no body
 *   - hashnode_validation_error     — non-auth GraphQL error envelope
 *   - hashnode_rate_limited         — 429
 *   - hashnode_provider_unavailable — 5xx OR Cloudflare/announcement
 *                                     redirect (the retired-free-API
 *                                     case the verifier already maps
 *                                     to `api_unavailable`) OR text/html
 *                                     body where JSON was expected
 *   - hashnode_network_error        — timeout / fetch failure
 *   - hashnode_api_error            — every other unexpected non-2xx
 *                                     or malformed JSON shape
 *
 * Secret hygiene
 * --------------
 *   - NEVER logs the api key.
 *   - NEVER retries automatically (idempotency is not guaranteed).
 *   - NEVER overwrites an existing post — the runner consults
 *     publish_history for duplicate protection.
 *   - The api key is taken as a parameter, used once in the Authorization
 *     header, and is never copied into the outcome's metadata.
 */

import { publishFail, publishOk } from "./publishing-result";
import type { PublishOutcome, PublishRequest } from "./publishing-types";
import { canonicalPostFromRequest } from "./canonical-post";
import {
  HASHNODE_PUBLISH_POST_MUTATION,
  transformForHashnode,
} from "./transformers/hashnode";
import { fetchWithTimeout, isTimeoutError } from "./fetch-with-timeout";

const HASHNODE_GQL_ENDPOINT = "https://gql.hashnode.com/";

export interface PublishHashnodeInput {
  request: PublishRequest;
  apiKey: string;
  publicationId: string;
}

interface HashnodeGraphqlResponse {
  data?: {
    publishPost?: {
      post?: {
        id?: string;
        url?: string;
        slug?: string;
        publishedAt?: string;
      };
    };
  };
  errors?: Array<{ message?: string; extensions?: Record<string, unknown> }>;
}

export async function publishToHashnode(
  input: PublishHashnodeInput,
): Promise<PublishOutcome> {
  const { request, apiKey, publicationId } = input;

  if (!apiKey || apiKey.trim().length === 0) {
    return publishFail(
      "hashnode_token_missing",
      "Hashnode: no API key available for this identity. Connect Hashnode from the identity card or set HASHNODE_API_KEY (legacy fallback).",
    );
  }
  if (!publicationId || publicationId.trim().length === 0) {
    return publishFail(
      "hashnode_publication_missing",
      "Hashnode: this identity has no publication selected. Open Settings → Setup → Hashnode and choose a publication.",
    );
  }
  if (!request.title || request.title.trim().length === 0) {
    return publishFail(
      "hashnode_title_required",
      "Hashnode articles require a title.",
    );
  }
  if (!request.body || request.body.trim().length === 0) {
    return publishFail(
      "hashnode_body_required",
      "Hashnode articles require body markdown.",
    );
  }

  const post = canonicalPostFromRequest(request);
  const inputPayload = transformForHashnode(post, { publicationId });

  let response: Response;
  try {
    response = await fetchWithTimeout(HASHNODE_GQL_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: HASHNODE_PUBLISH_POST_MUTATION,
        variables: { input: inputPayload },
      }),
      // Match the verifier — observe Hashnode's edge redirects rather
      // than transparently following them to the announcement page.
      redirect: "manual",
      timeoutMs: 20_000,
    });
  } catch (err) {
    if (isTimeoutError(err)) {
      return publishFail(
        "hashnode_network_error",
        "Hashnode didn't respond in time (20s). The post wasn't sent — try again.",
        { endpoint: "publishPost" },
      );
    }
    return publishFail(
      "hashnode_network_error",
      `Hashnode network error: ${
        err instanceof Error ? err.message : "unknown"
      }`,
      { endpoint: "publishPost" },
    );
  }

  // Hashnode retired free GraphQL API access. Edge serves a 301/308
  // redirect to the announcement page BEFORE the Authorization header
  // is evaluated. Manual-redirect mode lets us spot this directly.
  // Surfacing it as `hashnode_provider_unavailable` (rather than
  // `hashnode_token_invalid`) avoids sending operators chasing a
  // phantom credential problem.
  if (
    response.status === 301 ||
    response.status === 302 ||
    response.status === 307 ||
    response.status === 308 ||
    response.type === "opaqueredirect"
  ) {
    return publishFail(
      "hashnode_provider_unavailable",
      "Hashnode GraphQL API access is not available for this account. Hashnode now requires API access to be enabled for the publication/account. Use manual publishing for now, or enable the required Hashnode plan and try again.",
      { http_status: response.status, endpoint: "publishPost" },
    );
  }

  if (response.status === 401 || response.status === 403) {
    return publishFail(
      "hashnode_token_invalid",
      `Hashnode returned ${response.status}; the API key may be invalid or revoked. Reconnect from the identity card.`,
      { http_status: response.status, endpoint: "publishPost" },
    );
  }
  if (response.status === 429) {
    return publishFail(
      "hashnode_rate_limited",
      "Hashnode returned 429; back off and retry later.",
      { http_status: 429, endpoint: "publishPost" },
    );
  }
  if (response.status >= 500 && response.status < 600) {
    return publishFail(
      "hashnode_provider_unavailable",
      `Hashnode returned HTTP ${response.status}; the provider is unavailable. Try again.`,
      { http_status: response.status, endpoint: "publishPost" },
    );
  }

  // Defensive: announcement HTML served as a 200. Same case as the
  // verifier's content-type guard.
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("text/html")) {
    return publishFail(
      "hashnode_provider_unavailable",
      "Hashnode returned HTML instead of JSON — the GraphQL API may be retired for this account.",
      { http_status: response.status, endpoint: "publishPost" },
    );
  }

  if (!response.ok) {
    return publishFail(
      "hashnode_api_error",
      `Hashnode returned HTTP ${response.status}.`,
      { http_status: response.status, endpoint: "publishPost" },
    );
  }

  let json: HashnodeGraphqlResponse;
  try {
    json = (await response.json()) as HashnodeGraphqlResponse;
  } catch (err) {
    return publishFail(
      "hashnode_api_error",
      `Hashnode response was not JSON: ${
        err instanceof Error ? err.message : "unknown"
      }`,
      { http_status: response.status, endpoint: "publishPost" },
    );
  }

  // GraphQL returns 200 OK with an `errors` array on validation /
  // auth failures. Split auth vs validation so the operator-facing
  // copy is actionable.
  if (json.errors && json.errors.length > 0) {
    const first = json.errors[0] ?? {};
    const ext = (first.extensions ?? {}) as Record<string, unknown>;
    const code = typeof ext.code === "string" ? ext.code : "";
    const message = typeof first.message === "string" ? first.message : "";
    const looksAuth =
      code === "UNAUTHENTICATED" ||
      code === "FORBIDDEN" ||
      /auth|token|unauthor/i.test(message);
    if (looksAuth) {
      return publishFail(
        "hashnode_token_invalid",
        "Hashnode rejected the API key. Reconnect from the identity card.",
        { http_status: response.status, endpoint: "publishPost" },
      );
    }
    // Never echo the raw GraphQL message verbatim — the spec doesn't
    // forbid headers being echoed in error contexts. We surface the
    // extension code (which is well-bounded enum-style data) and a
    // trimmed message excerpt, with the api key redacted as
    // defense-in-depth (the only secret we know the value of in this
    // scope; the cipher key + cookies aren't reachable here).
    const redacted = redactToken(message, apiKey).slice(0, 280);
    return publishFail(
      "hashnode_validation_error",
      `Hashnode validation: ${code || "unknown"}${redacted ? ` — ${redacted}` : ""}`,
      { http_status: response.status, endpoint: "publishPost" },
    );
  }

  const result = json.data?.publishPost?.post;
  if (!result || !result.id) {
    return publishFail(
      "hashnode_api_error",
      "Hashnode response did not include a post id.",
      { http_status: response.status, endpoint: "publishPost" },
    );
  }

  return publishOk({
    externalId: result.id,
    externalUrl: result.url ?? null,
    metadata: {
      endpoint: "publishPost",
      http_status: response.status,
      slug: result.slug ?? null,
      published_at: result.publishedAt ?? null,
      publication_id: publicationId,
      intent: "article",
    },
  });
}

/**
 * Replace any literal occurrence of the api key with `[REDACTED]`.
 * Defensive — we don't expect Hashnode to echo it back, but the
 * GraphQL error envelope is upstream-controlled, and a single leak
 * in a publish_history.reason_detail field is far worse than
 * stripping a few characters from an error message.
 */
function redactToken(message: string, token: string): string {
  if (!message || !token || token.length < 8) return message;
  return message.split(token).join("[REDACTED]");
}
