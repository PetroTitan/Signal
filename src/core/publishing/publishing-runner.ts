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

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  evaluatePublishingPolicy,
  type PolicyContext,
} from "./publishing-policy";
import type { PublishPlatform } from "./publishing-types";
import { publishToReddit } from "./publish-reddit";
import { publishXForIdentity } from "./x-publish-orchestrator";
import { publishToLinkedIn } from "./publish-linkedin";
import { publishDevtoForIdentity } from "./devto-publish-orchestrator";
import { publishHashnodeForIdentity } from "./hashnode-publish-orchestrator";
import { publishBlueskyForIdentity } from "./bluesky-publish-orchestrator";
import { publishToTelegram } from "./publish-telegram";
import { readTelegramCredentials } from "./platform-credentials";
import { publishBlocked, publishFail } from "./publishing-result";
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
  /**
   * Optional Supabase client to thread down to platform adapters that
   * need to re-read identity / connection rows during the publish call
   * (currently only Bluesky). The scheduler tick runs without an
   * operator cookie, so RLS would otherwise hide growth_accounts from
   * the orchestrator's identity lookup. Manual publish callers leave
   * this undefined — the orchestrator falls back to the cookie-aware
   * client and RLS allows the operator's own workspace rows.
   *
   * Other platform cases ignore this field — they publish via env
   * credentials or HTTP fetch without further Supabase reads.
   */
  db?: SupabaseClient;
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
      // Phase F7.1 — identity-scoped dev.to publishing. The
      // orchestrator loads THIS identity's encrypted API key,
      // decrypts it for the single network call, and routes failures
      // through dev.to-prefixed reason codes. Workspace-level
      // DEVTO_API_KEY env is reachable ONLY as an opt-in legacy
      // fallback (DEVTO_LEGACY_FALLBACK=true) — default behaviour
      // fails safe with `devto_token_missing`.
      return publishDevtoForIdentity({
        request: input.request,
        db: input.db,
      });
    }
    case "hashnode": {
      // Phase F8 — identity-scoped Hashnode publishing. The
      // orchestrator loads THIS identity's encrypted API key,
      // decrypts it for the single network call, and routes
      // failures through Hashnode-prefixed reason codes. Workspace-
      // level HASHNODE_API_KEY + HASHNODE_PUBLICATION_ID env vars
      // are reachable ONLY as an opt-in legacy fallback
      // (HASHNODE_LEGACY_FALLBACK=true) — default behaviour fails
      // safe with `hashnode_token_missing` /
      // `hashnode_publication_missing`.
      return publishHashnodeForIdentity({
        request: input.request,
        db: input.db,
      });
    }
    case "bluesky": {
      // Identity-scoped publishing: the orchestrator loads THIS
      // identity's encrypted session, decrypts it for outbound use,
      // and runs the publish + at-most-one-refresh flow. The
      // workspace-level BLUESKY_APP_PASSWORD is reached only as an
      // opt-in legacy fallback when (a) the identity has no
      // session AND (b) BLUESKY_LEGACY_FALLBACK is explicitly
      // enabled. Default behaviour is fail-safe with
      // session_missing.
      return publishBlueskyForIdentity({
        request: input.request,
        db: input.db,
      });
    }
    case "telegram": {
      const creds = readTelegramCredentials();
      if (!creds) {
        return publishFail(
          "missing_api_key",
          "TELEGRAM_BOT_TOKEN is not configured.",
        );
      }
      // The chat id (channel @username or numeric) lives on
      // `platform_connections.provider_account_id`, persisted by the
      // /api/identity/[id]/telegram/verify route after `getChat +
      // getChatMember` confirms the bot has admin access. The runner
      // doesn't talk to the DB directly — the scheduler reads the
      // chat id from the connection row and threads it into
      // `request.target`. Manual callers may override by setting
      // `execution_items.metadata.target` (operator-visible value).
      const chatId = input.request.target ?? input.target ?? "";
      if (!chatId) {
        return publishFail(
          "missing_identifier",
          "Telegram: this identity has no channel set. Add the channel @username or numeric chat id on the identity card.",
        );
      }
      return publishToTelegram({
        request: input.request,
        botToken: creds.botToken,
        chatId,
      });
    }
    case "youtube":
    case "threads":
    case "instagram":
      // Manual-distribution platforms — never reach the runner with
      // mode='live'. They are recorded via recordManualDistributionAction
      // after the founder publishes by hand on the native composer.
      return publishFail(
        "platform_not_supported",
        "This platform publishes manually — use the publish detail page to copy + post + record.",
      );
  }

  // OAuth platforms — gated by the policy verdict and the stored token.
  if (!input.accessToken) {
    return publishFail(
      "oauth_token_not_stored",
      "Runner reached the publisher with a null token; policy gate should have caught this.",
    );
  }

  switch (input.request.platform) {
    case "reddit": {
      if (!input.target) {
        return publishFail(
          "missing_subreddit",
          "Reddit requires a target subreddit.",
        );
      }
      // Autonomous Reddit publishing is opt-in, default off.
      //
      // Until the routing target was threaded from the plan item to the
      // execution item, this branch was unreachable from the scheduler:
      // `input.target` was always null and the gate above refused. The
      // fix revives the path, and it revives it into a place with none
      // of the manual path's protections — no typed confirmation
      // phrase, no rate limit, no duplicate fingerprint check.
      //
      // The manual path has always required the subreddit to be in
      // ALLOWED_TEST_SUBREDDITS (`safe-test-policy`). The autonomous
      // path now enforces the SAME rule rather than a weaker one, plus
      // an explicit env opt-in — so an operator turns this on
      // deliberately, for subreddits they have already listed.
      //
      // This branch does NOT gate the operator-confirmed manual publish
      // at /execution/items/[id], which calls `publishToReddit`
      // directly with the subreddit typed into the form.
      const { redditAutonomousPublishEnabled, isSubredditAllowed } =
        await import("./safe-test-env");
      if (!redditAutonomousPublishEnabled()) {
        return publishBlocked(
          "reddit_autonomous_publish_disabled",
          "Autonomous Reddit publishing is off. Publish this post from the execution detail page, or set REDDIT_AUTONOMOUS_PUBLISH=true to let the scheduler post to allow-listed subreddits.",
        );
      }
      if (!isSubredditAllowed(input.target)) {
        return publishBlocked(
          "subreddit_not_allowlisted",
          `r/${input.target} is not in ALLOWED_TEST_SUBREDDITS. The scheduler only posts to subreddits you have explicitly listed.`,
        );
      }
      return publishToReddit({
        request: input.request,
        accessToken: input.accessToken,
        subreddit: input.target,
      });
    }
    case "x":
      return publishXForIdentity({
        request: input.request,
        accessToken: input.accessToken,
        db: input.db,
      });
    case "linkedin":
      return publishToLinkedIn();
  }
}

/**
 * Platforms with a REAL publisher — one that actually dispatches a
 * provider request.
 *
 * This is the ceiling for every capability claim in the system:
 *
 *     MCP schedulable ⊆ scheduler autonomous ⊆ real publisher
 *
 * Membership is declared here, beside the dispatch switch, and pinned
 * by a static test that scans `publish-*.ts` for the
 * `publishNotImplemented` marker. The declaration therefore cannot
 * drift from the code it describes: adding a stub to this set, or
 * implementing a publisher without declaring it, fails the build.
 *
 * LinkedIn is deliberately absent. `publishToLinkedIn` is a stub, and
 * its OAuth callback is not implemented either, so a LinkedIn item can
 * never obtain a token — it must not be advertised as autonomous.
 * YouTube, Threads and Instagram publish through the manual
 * distribution path and have no publisher at all.
 *
 * The declaration itself now lives in the PURE
 * `publish-capability-registry` module and is re-exported here
 * unchanged. This module is `server-only`, so client surfaces (the
 * compose sheet's destination selector) could not read capability
 * truth from here — and the one that needed it grew a hardcoded
 * shadow list instead. Moving the declaration, rather than copying
 * it, is what removes the drift.
 */
export { PLATFORMS_WITH_REAL_PUBLISHER } from "./publish-capability-registry";
