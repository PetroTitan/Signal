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
import { publishToX, uploadXMedia } from "./publish-x";
import { publishBlocked, publishFail } from "./publishing-result";
import type { PublishOutcome, PublishRequest } from "./publishing-types";
import { resolveProviderMediaForPublish } from "@/core/creatives/resolve-provider-derivative";

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

  // 3. Optional media upload. The scheduler's resolvePublishCreative
  //    only attaches a creative when an approved row exists with a
  //    fetchable asset URL — so a non-null `request.creative` here is
  //    an operator-approved attach. We upload it via /2/media/upload
  //    BEFORE the tweet POST so the tweet either goes out with the
  //    image or fails clearly with the upload reason.
  //
  //    No silent downgrade: if upload fails, the publisher does NOT
  //    fall back to a text-only tweet. The operator approved the
  //    image; surfacing the failure (x_media_upload_unavailable for
  //    tier-gated 403; x_media_upload_failed for other errors) is
  //    safer than publishing a different post than they approved.
  let mediaId: string | null = null;
  // Provider-media preparation metadata recorded on the eventual
  // outcome (→ execution_logs) so the operator can see how the
  // creative was prepared for X.
  let mediaPrepMetadata: Record<string, unknown> = {};
  if (request.creative) {
    const photoUrl =
      request.creative.assetUrl ?? request.creative.sourceUrl ?? null;
    if (!photoUrl || photoUrl.trim().length === 0) {
      return tagPublishPath(
        publishFail(
          "x_media_upload_failed",
          "Approved creative has no fetchable URL (assetUrl/sourceUrl both empty).",
          {
            endpoint: "media/upload",
            media_mode: "x_image",
            creative_id: request.creative.id,
            media_url_present: false,
            x_media_id_present: false,
          },
        ),
      );
    }

    // Provider-media preparation (Phase 2) BEFORE /2/media/upload and
    // BEFORE the tweet. If the approved image is too large for X, a
    // provider-safe derivative is generated + stored and we upload THAT
    // instead of the original (original row untouched). An unpreparable
    // creative (oversized GIF, transform failure, video) blocks here —
    // no silent text-only downgrade, X media + tweet APIs never called.
    const media = await resolveProviderMediaForPublish({
      platform: "x",
      request,
      db,
    });
    if (media.kind === "blocked") {
      return tagPublishPath(media.outcome);
    }
    const effectiveCreative =
      media.kind === "derivative" ? media.creative : request.creative;
    mediaPrepMetadata = media.metadata;
    // Use the derivative URL when one was produced; otherwise the
    // original (which prep confirmed is within X's limit).
    const uploadUrl =
      effectiveCreative.assetUrl ?? effectiveCreative.sourceUrl ?? photoUrl;

    const upload = await uploadXMedia({ accessToken, photoUrl: uploadUrl });
    if (!upload.ok && upload.tooLarge) {
      // In-flight provider-media block (oversized image — only reachable
      // when the stored size was unknown so no derivative was made).
      return tagPublishPath(
        publishBlocked(
          "media_too_large_for_platform",
          upload.reasonDetail,
          {
            endpoint: "media/upload",
            media_mode: "x_image",
            media_preparation_status: "blocked",
            creative_id: request.creative.id,
            media_url_present: true,
            x_media_id_present: false,
          },
        ),
      );
    }
    if (!upload.ok) {
      return tagPublishPath(
        publishFail(upload.reasonCode, upload.reasonDetail, {
          endpoint: "media/upload",
          media_mode: "x_image",
          creative_id: request.creative.id,
          media_url_present: true,
          x_media_id_present: false,
          ...(upload.httpStatus ? { http_status: upload.httpStatus } : {}),
        }),
      );
    }
    mediaId = upload.mediaId;
  }

  // 4. Hand to the pure publisher.
  const outcome = await publishToX({
    request,
    accessToken,
    username,
    mediaId,
  });

  // Tag the creative_id on success so publish_history records which
  // approved creative was actually attached.
  const withCreativeTag = request.creative
    ? {
        ...outcome,
        metadata: {
          ...outcome.metadata,
          creative_id: request.creative.id,
          ...mediaPrepMetadata,
        },
      }
    : outcome;

  return tagPublishPath(withCreativeTag);
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
