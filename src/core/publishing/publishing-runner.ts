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
