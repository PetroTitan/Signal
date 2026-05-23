import "server-only";
/**
 * Phase F1 — publishing runner.
 *
 * Given a `PublishRequest` + the live workspace context, the runner:
 *   1. consults the policy gate
 *   2. (if approved) dispatches to the platform-specific publisher
 *   3. returns a `PublishOutcome` describing the verdict
 *
 * The runner never decrypts or logs the token. It receives the
 * decrypted value as a parameter from the scheduler and is expected
 * to discard it after the call.
 */

import {
  evaluatePublishingPolicy,
  type PolicyContext,
} from "./publishing-policy";
import { publishToReddit } from "./publish-reddit";
import { publishToX } from "./publish-x";
import { publishToLinkedIn } from "./publish-linkedin";
import { publishToDevto } from "./publish-devto";
import { publishToHashnode } from "./publish-hashnode";
import { publishToBluesky } from "./publish-bluesky";
import {
  readBlueskyCredentials,
  readDevtoCredentials,
  readHashnodeCredentials,
} from "./platform-credentials";
import { publishFail } from "./publishing-result";
import type { PublishOutcome, PublishRequest } from "./publishing-types";

export interface RunnerInput {
  request: PublishRequest;
  context: Omit<PolicyContext, "request">;
  /** Decrypted access token; null when not available. The runner
   *  expects the policy gate to already have refused when this is
   *  null, but is defensive about it. */
  accessToken: string | null;
  /** Target on the platform (e.g. subreddit). */
  target: string | null;
}

export async function runPublish(input: RunnerInput): Promise<PublishOutcome> {
  const verdict = evaluatePublishingPolicy({
    request: input.request,
    ...input.context,
  });
  if (verdict) return verdict;

  // Tier-1 platforms (dev.to, Hashnode, Bluesky) use API-key /
  // app-password credentials read from env at publish time, not the
  // stored OAuth access token. They short-circuit the OAuth check
  // that gates the OAuth platforms below.
  switch (input.request.platform) {
    case "devto": {
      const creds = readDevtoCredentials();
      if (!creds) {
        return publishFail(
          "missing_api_key",
          "DEVTO_API_KEY is not configured.",
        );
      }
      return publishToDevto({
        request: input.request,
        apiKey: creds.apiKey,
        published: true,
      });
    }
    case "hashnode": {
      const creds = readHashnodeCredentials();
      if (!creds) {
        return publishFail(
          "missing_api_key",
          "HASHNODE_API_KEY / HASHNODE_PUBLICATION_ID are not configured.",
        );
      }
      return publishToHashnode({
        request: input.request,
        apiKey: creds.apiKey,
        publicationId: creds.publicationId,
      });
    }
    case "bluesky": {
      const creds = readBlueskyCredentials();
      if (!creds) {
        return publishFail(
          "missing_identifier",
          "BLUESKY_IDENTIFIER / BLUESKY_APP_PASSWORD are not configured.",
        );
      }
      return publishToBluesky({
        request: input.request,
        identifier: creds.identifier,
        appPassword: creds.appPassword,
        service: creds.service,
      });
    }
  }

  // OAuth platforms — gated by the policy verdict and the stored token.
  if (!input.accessToken) {
    return publishFail(
      "oauth_token_not_stored",
      "Runner reached the publisher with a null token; policy gate should have caught this.",
    );
  }

  switch (input.request.platform) {
    case "reddit":
      if (!input.target) {
        return publishFail(
          "missing_subreddit",
          "Reddit requires a target subreddit.",
        );
      }
      return publishToReddit({
        request: input.request,
        accessToken: input.accessToken,
        subreddit: input.target,
      });
    case "x":
      return publishToX();
    case "linkedin":
      return publishToLinkedIn();
  }
}
