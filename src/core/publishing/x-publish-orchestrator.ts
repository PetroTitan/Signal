import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * X identity-scoped publish orchestrator.
 *
 * Thin parallel to the Reddit / dev.to / Bluesky orchestrators. The
 * pure publisher in `publish-x.ts` posts under a given access token;
 * this module owns:
 *
 *   1. Workspace-scoped identity lookup. Cross-platform routing bugs
 *      (X-intended item with a non-X identity) are refused.
 *   2. Reading the (workspace, account, "x") connection row to
 *      surface the username — used to build the canonical permalink
 *      `https://x.com/<username>/status/<tweet_id>`.
 *   3. Tagging the outcome with `x_publish_path: "identity"` for
 *      audit parity with the dev.to / Bluesky tagging convention.
 *
 * Token refresh runs UPSTREAM in the scheduler (see
 * `ensureFreshXAccessToken`) before this orchestrator is called. The
 * orchestrator does NOT decrypt tokens — the runner passes the
 * already-decrypted access token in `input.accessToken`. Plaintext
 * stays in the runner / publisher stack frame for the single call.
 *
 * Strict scope rules:
 *   - Identity-scoped only; never publishes through a workspace-wide
 *     X credential.
 *   - No retry loop. The publisher returns a structured outcome and
 *     the scheduler decides what to do with it.
 *   - No tokens in any returned `metadata`, log line, or error.
 */

import { getAccountById } from "@/repositories/account-repository";
import { getConnectionForAccount } from "@/repositories/platform-connection-repository";
import { publishToX } from "./publish-x";
import { publishFail } from "./publishing-result";
import type { PublishOutcome, PublishRequest } from "./publishing-types";

export interface XOrchestratorInput {
  request: PublishRequest;
  /**
   * Decrypted OAuth access token. The scheduler ran
   * `ensureFreshXAccessToken` before invoking the runner, so this
   * value is either the original (still-fresh) token or the rotated
   * one. Null when no token is available — the orchestrator surfaces
   * a clear reason rather than hitting X with an empty Bearer.
   */
  accessToken: string | null;
  /**
   * Optional Supabase client. The cron-triggered scheduler tick
   * threads its service-role client so the repo lookups (identity +
   * connection) work without an operator cookie.
   */
  db?: SupabaseClient;
}

/**
 * Identity-scoped X publish.
 */
export async function publishXForIdentity(
  input: XOrchestratorInput,
): Promise<PublishOutcome> {
  const { request, accessToken, db } = input;

  if (!request.accountId) {
    return publishFail(
      "missing_account",
      "X publish requires an identity (accountId).",
    );
  }
  if (!accessToken || accessToken.trim().length === 0) {
    return publishFail(
      "x_token_missing",
      "X identity has no decrypted access token. Reconnect from the identity card.",
    );
  }

  // 1. Identity row — workspace-scoped lookup. Cross-workspace ids
  //    are refused.
  let identity;
  try {
    identity = await getAccountById(request.workspaceId, request.accountId, db);
  } catch {
    return publishFail("missing_account", "Identity not found in workspace.");
  }
  if (identity.platform !== "x") {
    return publishFail(
      "platform_mismatch",
      `Identity is on "${identity.platform}", not X.`,
    );
  }

  // 2. Connection row — needed only to build the permalink. Tokens
  //    are already decrypted upstream; we do NOT read the encrypted
  //    columns here.
  const conn = await getConnectionForAccount(
    request.workspaceId,
    request.accountId,
    "x" as never,
    db,
  );
  // username (handle) drives the permalink. If absent (legacy row,
  // mismatched connection, or upstream failure), the publisher falls
  // back to `https://x.com/i/status/<id>` which X resolves correctly.
  const username = conn?.handle ?? null;

  // 3. Hand to the pure publisher.
  const outcome = await publishToX({
    request,
    accessToken,
    username,
  });

  return tagPublishPath(outcome);
}

function tagPublishPath(outcome: PublishOutcome): PublishOutcome {
  return {
    ...outcome,
    metadata: {
      ...outcome.metadata,
      x_publish_path: "identity",
    },
  };
}
