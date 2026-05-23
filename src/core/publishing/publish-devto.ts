import "server-only";
/**
 * Phase F4 — dev.to publisher.
 *
 * Calls the Forem `/api/articles` endpoint with an API key. dev.to is
 * a Forem instance, so the same endpoint shape applies for any Forem
 * deployment if we ever generalize.
 *
 * Reference: https://developers.forem.com/api/v1#tag/articles/operation/createArticle
 *
 * Authentication: `api-key: <DEVTO_API_KEY>` header.
 *
 * NEVER:
 *   - logs the api key
 *   - retries automatically on rate-limit (the caller can re-queue)
 *   - silently dedups (the runner consults publish_history first)
 */

import { publishFail, publishOk } from "./publishing-result";
import type { PublishOutcome, PublishRequest } from "./publishing-types";
import {
  canonicalPostFromRequest,
  type CanonicalPost,
} from "./canonical-post";
import {
  transformForDevto,
  type DevtoPayload,
} from "./transformers/devto";

const DEVTO_API_BASE = "https://dev.to/api";

export interface PublishDevtoInput {
  request: PublishRequest;
  /** From readDevtoCredentials(); caller's responsibility. */
  apiKey: string;
  /** When true, publishes immediately; when false, saves a draft. */
  published: boolean;
}

interface DevtoApiArticle {
  id: number;
  url?: string;
  canonical_url?: string;
  slug?: string;
  published_at?: string | null;
}

/**
 * Pure helpers — exported for unit tests; not for runtime use.
 */
export function buildDevtoRequestBody(
  post: CanonicalPost,
  options: { published: boolean },
): DevtoPayload {
  return transformForDevto(post, options);
}

export async function publishToDevto(
  input: PublishDevtoInput,
): Promise<PublishOutcome> {
  const { request, apiKey, published } = input;

  if (!apiKey || apiKey.trim().length === 0) {
    return publishFail(
      "missing_api_key",
      "dev.to: set DEVTO_API_KEY before publishing.",
    );
  }
  if (!request.title || request.title.trim().length === 0) {
    return publishFail("missing_title", "dev.to articles need a title.");
  }
  if (!request.body || request.body.trim().length === 0) {
    return publishFail("missing_body", "dev.to articles need body markdown.");
  }

  const post = canonicalPostFromRequest(request);
  const payload = transformForDevto(post, { published });

  let response: Response;
  try {
    response = await fetch(`${DEVTO_API_BASE}/articles`, {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/vnd.forem.api-v1+json",
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return publishFail(
      "platform_api_error",
      `dev.to network error: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }

  if (response.status === 401 || response.status === 403) {
    return publishFail(
      "platform_unauthorized",
      `dev.to returned ${response.status}; the API key may be invalid or revoked.`,
      { http_status: response.status },
    );
  }
  if (response.status === 429) {
    return publishFail(
      "platform_rate_limited",
      "dev.to returned 429; back off and retry later.",
      { http_status: 429 },
    );
  }
  if (response.status === 422) {
    let detail = "validation failed";
    try {
      const body = (await response.json()) as { error?: string };
      if (body?.error) detail = body.error;
    } catch {
      // ignore body parse failure
    }
    return publishFail(
      "platform_api_error",
      `dev.to validation: ${detail}`,
      { http_status: 422 },
    );
  }
  if (!response.ok) {
    return publishFail(
      "platform_api_error",
      `dev.to returned HTTP ${response.status}.`,
      { http_status: response.status },
    );
  }

  let json: DevtoApiArticle;
  try {
    json = (await response.json()) as DevtoApiArticle;
  } catch (err) {
    return publishFail(
      "platform_api_error",
      `dev.to response was not JSON: ${
        err instanceof Error ? err.message : "unknown"
      }`,
    );
  }

  if (!json || typeof json.id !== "number") {
    return publishFail(
      "platform_api_error",
      "dev.to response was missing an article id.",
    );
  }

  return publishOk({
    externalId: String(json.id),
    externalUrl: json.url ?? null,
    metadata: {
      slug: json.slug ?? null,
      canonical_url: json.canonical_url ?? null,
      published_at: json.published_at ?? null,
      mode: published ? "published" : "draft",
    },
  });
}
