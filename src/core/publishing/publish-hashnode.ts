import "server-only";
/**
 * Phase F4 — Hashnode publisher.
 *
 * Hashnode publishes via GraphQL at https://gql.hashnode.com/. The
 * relevant operation is `publishPost(input: PublishPostInput!)`.
 *
 * Reference: https://apidocs.hashnode.com/#mutation-publishPost
 *
 * Authentication: `Authorization: <HASHNODE_API_KEY>` header (note
 * the API expects the raw token, NOT `Bearer <token>`).
 *
 * NEVER:
 *   - logs the api key
 *   - retries automatically
 *   - silently overwrites an existing post — the runner consults
 *     publish_history for duplicate protection.
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
      "missing_api_key",
      "Hashnode: set HASHNODE_API_KEY before publishing.",
    );
  }
  if (!publicationId || publicationId.trim().length === 0) {
    return publishFail(
      "missing_publication_id",
      "Hashnode: set HASHNODE_PUBLICATION_ID before publishing.",
    );
  }
  if (!request.title || request.title.trim().length === 0) {
    return publishFail("missing_title", "Hashnode posts need a title.");
  }
  if (!request.body || request.body.trim().length === 0) {
    return publishFail("missing_body", "Hashnode posts need body markdown.");
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
      timeoutMs: 20_000,
    });
  } catch (err) {
    if (isTimeoutError(err)) {
      return publishFail(
        "platform_api_error",
        "Hashnode didn't respond in time (20s). The post wasn't sent — try again.",
      );
    }
    return publishFail(
      "platform_api_error",
      `Hashnode network error: ${
        err instanceof Error ? err.message : "unknown"
      }`,
    );
  }

  if (response.status === 401 || response.status === 403) {
    return publishFail(
      "platform_unauthorized",
      `Hashnode returned ${response.status}; the API key may be invalid or revoked.`,
      { http_status: response.status },
    );
  }
  if (response.status === 429) {
    return publishFail(
      "platform_rate_limited",
      "Hashnode returned 429; back off and retry later.",
      { http_status: 429 },
    );
  }

  let json: HashnodeGraphqlResponse;
  try {
    json = (await response.json()) as HashnodeGraphqlResponse;
  } catch (err) {
    return publishFail(
      "platform_api_error",
      `Hashnode response was not JSON: ${
        err instanceof Error ? err.message : "unknown"
      }`,
    );
  }

  // GraphQL returns 200 OK with an `errors` array on validation failures.
  if (json.errors && json.errors.length > 0) {
    const msg = json.errors
      .map((e) => e.message ?? "unknown error")
      .join("; ")
      .slice(0, 280);
    return publishFail("platform_api_error", `Hashnode: ${msg}`, {
      errors: json.errors,
    });
  }

  const result = json.data?.publishPost?.post;
  if (!result || !result.id) {
    return publishFail(
      "platform_api_error",
      "Hashnode response did not include a post id.",
    );
  }

  return publishOk({
    externalId: result.id,
    externalUrl: result.url ?? null,
    metadata: {
      slug: result.slug ?? null,
      published_at: result.publishedAt ?? null,
      publication_id: publicationId,
    },
  });
}
