"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import {
  getExecutionItemById,
  updateItemStatus,
} from "@/repositories/execution-item-repository";
import { recordLog } from "@/repositories/execution-log-repository";
import { updatePlanItemStatus } from "@/repositories/weekly-plan-repository";
import { recordActivity } from "@/repositories/activity-repository";
import { insertPublishHistory } from "@/repositories/publish-history-repository";
import { evaluateSafeTestPolicy } from "@/core/publishing/safe-test-policy";
import { decryptForOutboundUse } from "@/core/platform-oauth";
import { publishToReddit } from "@/core/publishing/publish-reddit";
import { computeFingerprint } from "@/core/publishing/publish-fingerprint";
import { RepositoryError } from "@/repositories/errors";
import {
  actionFail,
  actionOk,
  type ActionResult,
} from "@/lib/forms/action-result";

export type PublishItemResult = ActionResult<{
  executionItemId: string;
  permalink: string | null;
  providerPostId: string | null;
}>;

/**
 * Phase F2.5 — controlled-publish server action.
 *
 * Sequence:
 *   1. Verify workspace + item ownership.
 *   2. Run evaluateSafeTestPolicy (every gate, every time).
 *   3. Re-fetch + decrypt the access token.
 *   4. Call Reddit /api/submit.
 *   5. Persist outcome to publish_history.
 *   6. Walk execution_item ready → running → completed/failed.
 *   7. Mirror weekly_plan_items.status = 'published' on success.
 *   8. Append execution_log + activity event.
 *
 * Token plaintext lives in this function's scope only.
 */
export async function publishItemAction(
  _prev: PublishItemResult,
  formData: FormData,
): Promise<PublishItemResult> {
  const executionItemId = String(formData.get("execution_item_id") ?? "").trim();
  const confirmationPhrase = String(formData.get("confirmation_phrase") ?? "");
  const subredditRaw = String(formData.get("subreddit") ?? "").trim();
  if (!executionItemId) return actionFail("Missing execution_item_id.");
  if (!subredditRaw) return actionFail("Subreddit is required.");

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const workspaceId = membership.workspace.id;

    const item = await getExecutionItemById(workspaceId, executionItemId);
    if (item.status !== "ready") {
      return actionFail(
        `Item is in '${item.status}', not 'ready'. Wait for the scheduler to mark it ready_for_publish.`,
      );
    }

    const supabase = createSupabaseServerClient();
    const nowIso = new Date().toISOString();

    const verdict = await evaluateSafeTestPolicy({
      supabase,
      workspaceId,
      executionItem: {
        id: item.id,
        accountId: item.accountId,
        productId: item.productId,
        platform: item.platform,
        title: item.title,
        body: item.body,
        linkUrl: item.linkUrl,
        scheduledAt: item.scheduledAt,
        actionType: item.actionType,
        metadata: item.metadata as Record<string, unknown>,
      },
      confirmationPhrase,
      subreddit: subredditRaw,
      nowIso,
    });
    if (!verdict.ok) {
      // Record the blocked attempt so the duplicate window + audit
      // surface know about it. Rate-limit and duplicate-window
      // blocks do NOT consume rate-limit budget — only outcome=
      // 'published' does.
      const fp = await computeFingerprint({
        platform: "reddit",
        subreddit: subredditRaw,
        title: item.title,
        body: item.body,
        linkUrl: item.linkUrl,
      });
      await insertPublishHistory({
        workspaceId,
        executionItemId: item.id,
        accountId: item.accountId,
        productId: item.productId,
        platform: "reddit",
        subreddit: subredditRaw,
        fingerprint: fp.fingerprint,
        titleHash: fp.titleHash,
        bodyHash: fp.bodyHash,
        linkUrl: item.linkUrl,
        providerPostId: null,
        providerPermalink: null,
        outcome: "blocked",
        reasonCode: verdict.reasonCode,
        httpStatus: null,
        startedAt: nowIso,
        metadata: { detail: verdict.reasonDetail ?? null },
      });
      await recordLog({
        workspaceId,
        queueId: item.queueId,
        executionItemId: item.id,
        eventType: "item.blocked",
        severity: "error",
        message: `[publish] blocked — ${verdict.reasonCode}: ${verdict.reasonDetail}`,
        metadata: { reason_code: verdict.reasonCode },
      });
      return actionFail(verdict.reasonDetail ?? "Policy refused publish.");
    }

    // ── Gate passes — decrypt + call Reddit.
    const { data: connRow } = await supabase
      .from("platform_connections")
      .select("access_token_encrypted")
      .eq("workspace_id", workspaceId)
      .eq("account_id", item.accountId)
      .eq("platform", "reddit")
      .maybeSingle();
    const enc =
      (connRow as { access_token_encrypted?: string | null } | null)
        ?.access_token_encrypted ?? null;
    const accessToken = enc ? decryptForOutboundUse(enc) : null;
    if (!accessToken) {
      return actionFail("Token decryption failed at submit time.");
    }

    // Walk ready → running.
    await updateItemStatus({
      workspaceId,
      itemId: item.id,
      to: "running",
    });

    const outcome = await publishToReddit({
      request: {
        workspaceId,
        planItemId:
          (item.metadata as { plan_item_id?: string })?.plan_item_id ?? "",
        executionItemId: item.id,
        platform: "reddit",
        accountId: item.accountId ?? "",
        productId: item.productId,
        title: item.title,
        body: item.body,
        linkUrl: item.linkUrl,
        target: subredditRaw,
        mode: "live",
      },
      accessToken,
      subreddit: subredditRaw,
    });
    const finishedAt = new Date().toISOString();
    const fpFinal = await computeFingerprint({
      platform: "reddit",
      subreddit: subredditRaw,
      title: item.title,
      body: item.body,
      linkUrl: item.linkUrl,
    });

    if (outcome.status === "published") {
      const permalink = outcome.externalUrl ?? null;
      const providerId = outcome.externalId ?? null;

      await insertPublishHistory({
        workspaceId,
        executionItemId: item.id,
        accountId: item.accountId,
        productId: item.productId,
        platform: "reddit",
        subreddit: subredditRaw,
        fingerprint: fpFinal.fingerprint,
        titleHash: fpFinal.titleHash,
        bodyHash: fpFinal.bodyHash,
        linkUrl: item.linkUrl,
        providerPostId: providerId,
        providerPermalink: permalink,
        outcome: "published",
        reasonCode: null,
        httpStatus: 200,
        startedAt: nowIso,
        metadata: { kind: outcome.metadata?.kind ?? null },
      });
      await updateItemStatus({
        workspaceId,
        itemId: item.id,
        to: "completed",
        patch: {
          metadata: {
            ...(item.metadata as Record<string, unknown>),
            publish_outcome: {
              status: "published",
              reason_code: null,
              external_id: providerId,
              external_url: permalink,
              published_at: finishedAt,
            },
          },
        },
      });
      const planItemId =
        (item.metadata as { plan_item_id?: string })?.plan_item_id ?? null;
      if (planItemId) {
        try {
          await updatePlanItemStatus({
            workspaceId,
            itemId: planItemId,
            status: "published",
          });
        } catch (err) {
          console.error("[publishItemAction] plan_item mirror failed", err);
        }
      }
      await recordLog({
        workspaceId,
        queueId: item.queueId,
        executionItemId: item.id,
        eventType: "item.completed",
        severity: "info",
        message: `[publish] published — ${permalink ?? providerId ?? "no permalink"}`,
        metadata: { permalink, provider_post_id: providerId, subreddit: subredditRaw },
      });
      try {
        await recordActivity({
          workspaceId,
          eventType: "reddit.post_published",
          entityType: "execution_item",
          entityId: item.id,
          title: `Reddit post published to r/${subredditRaw}`,
          description: permalink,
          metadata: { permalink, provider_post_id: providerId },
        });
      } catch (err) {
        console.error("[publishItemAction] activity log failed", err);
      }
      revalidatePath("/execution");
      revalidatePath(`/execution/${item.queueId}`);
      revalidatePath(`/execution/items/${item.id}`);
      revalidatePath("/weekly-plan");
      revalidatePath("/activity");
      return actionOk({
        executionItemId: item.id,
        permalink,
        providerPostId: providerId,
      });
    }

    // Failure path.
    await insertPublishHistory({
      workspaceId,
      executionItemId: item.id,
      accountId: item.accountId,
      productId: item.productId,
      platform: "reddit",
      subreddit: subredditRaw,
      fingerprint: fpFinal.fingerprint,
      titleHash: fpFinal.titleHash,
      bodyHash: fpFinal.bodyHash,
      linkUrl: item.linkUrl,
      providerPostId: null,
      providerPermalink: null,
      outcome: "failed",
      reasonCode: outcome.reasonCode,
      httpStatus:
        typeof outcome.metadata?.http_status === "number"
          ? (outcome.metadata.http_status as number)
          : null,
      startedAt: nowIso,
      metadata: { detail: outcome.reasonDetail ?? null },
    });
    await updateItemStatus({
      workspaceId,
      itemId: item.id,
      to: "failed",
      patch: {
        metadata: {
          ...(item.metadata as Record<string, unknown>),
          publish_outcome: {
            status: "failed",
            reason_code: outcome.reasonCode,
            reason_detail: outcome.reasonDetail,
          },
        },
      },
    });
    await recordLog({
      workspaceId,
      queueId: item.queueId,
      executionItemId: item.id,
      eventType: "item.failed",
      severity: "error",
      message: `[publish] failed — ${outcome.reasonCode}: ${outcome.reasonDetail}`,
      metadata: { reason_code: outcome.reasonCode },
    });
    revalidatePath(`/execution/items/${item.id}`);
    revalidatePath(`/execution/${item.queueId}`);
    return actionFail(outcome.reasonDetail ?? "Reddit refused publish.");
  } catch (err) {
    const msg =
      err instanceof RepositoryError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Publish failed.";
    console.error("[publishItemAction] failed", err);
    return actionFail(msg);
  }
}

// =====================================================================
// Phase F2.5 (manual fallback) — recordManualPublishAction
// =====================================================================
//
// Reddit API approval is currently blocked, so the controlled OAuth
// publish path can't fire. The manual fallback:
//   1. Operator copies the prepared payload from /execution/items/<id>
//   2. Operator manually posts on Reddit in a browser
//   3. Operator pastes the resulting permalink + confirmation phrase
//   4. This action runs the same gates as live publish (minus the
//      OAuth/token gates) and records the publish_history row
//
// What this is NOT:
//   - It does NOT call Reddit's API (the whole point — Reddit hasn't
//     approved us yet).
//   - It does NOT bypass the rate limit, duplicate check, whitelist,
//     creative readiness, or confirmation phrase.
//   - It does NOT trust an arbitrary URL: the permalink must parse
//     as a reddit.com /comments/<id> or a redd.it/<id> shortlink.

export type RecordManualPublishResult = ActionResult<{
  executionItemId: string;
  permalink: string;
  providerPostId: string;
}>;

export type PrepareForManualPublishResult = ActionResult<{
  executionItemId: string;
}>;

/**
 * Phase F2.6 — operator-explicit transition into the manual path.
 *
 * Walks an item from `ready` to `ready_for_manual_publish`. Has no
 * effect on items already in `ready_for_manual_publish` (idempotent).
 * Refuses items in any other state so the operator can't bypass the
 * scheduler.
 */
export async function prepareForManualPublishAction(
  _prev: PrepareForManualPublishResult,
  formData: FormData,
): Promise<PrepareForManualPublishResult> {
  const executionItemId = String(formData.get("execution_item_id") ?? "").trim();
  if (!executionItemId) return actionFail("Missing execution_item_id.");

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const workspaceId = membership.workspace.id;

    const item = await getExecutionItemById(workspaceId, executionItemId);
    if (item.status === "ready_for_manual_publish") {
      return actionOk({ executionItemId: item.id });
    }
    if (item.status !== "ready") {
      return actionFail(
        `Cannot prepare for manual publish from '${item.status}'. Item must be 'ready'.`,
      );
    }

    await updateItemStatus({
      workspaceId,
      itemId: item.id,
      to: "ready_for_manual_publish",
    });
    await recordLog({
      workspaceId,
      queueId: item.queueId,
      executionItemId: item.id,
      eventType: "item.ready_for_manual_publish",
      severity: "info",
      message:
        "[manual-publish] Operator prepared item for manual publishing. Signal prepared the payload; operator will publish manually on Reddit.",
      metadata: { source: "operator_action" },
    });
    revalidatePath(`/execution/items/${item.id}`);
    revalidatePath(`/execution/${item.queueId}`);
    revalidatePath("/weekly-plan");
    return actionOk({ executionItemId: item.id });
  } catch (err) {
    const msg =
      err instanceof RepositoryError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Could not prepare for manual publish.";
    console.error("[prepareForManualPublishAction] failed", err);
    return actionFail(msg);
  }
}

export async function recordManualPublishAction(
  _prev: RecordManualPublishResult,
  formData: FormData,
): Promise<RecordManualPublishResult> {
  const executionItemId = String(formData.get("execution_item_id") ?? "").trim();
  const confirmationPhrase = String(formData.get("confirmation_phrase") ?? "");
  const subredditRaw = String(formData.get("subreddit") ?? "").trim();
  const permalinkRaw = String(formData.get("permalink") ?? "").trim();
  const operatorNotes = String(formData.get("operator_notes") ?? "").trim() || null;
  if (!executionItemId) return actionFail("Missing execution_item_id.");
  if (!subredditRaw) return actionFail("Subreddit is required.");

  // Parse the permalink BEFORE we run any DB writes — fail fast on
  // bad input so we don't end up with half a recorded outcome.
  const { parseRedditPermalink, permalinkRejectionDetail } = await import(
    "@/core/publishing/reddit-permalink"
  );
  const parsed = parseRedditPermalink(permalinkRaw);
  if (!parsed) return actionFail(permalinkRejectionDetail(permalinkRaw));
  if (parsed.subreddit && parsed.subreddit.toLowerCase() !== subredditRaw.toLowerCase()) {
    return actionFail(
      `Permalink subreddit r/${parsed.subreddit} does not match the prepared payload's r/${subredditRaw}.`,
    );
  }

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const workspaceId = membership.workspace.id;

    const item = await getExecutionItemById(workspaceId, executionItemId);
    if (
      item.status !== "ready" &&
      item.status !== "ready_for_manual_publish"
    ) {
      return actionFail(
        `Cannot record from '${item.status}'. Item must be 'ready' or 'ready_for_manual_publish'.`,
      );
    }

    const supabase = createSupabaseServerClient();
    const nowIso = new Date().toISOString();

    // Duplicate-permalink guard. The DB has a partial unique index
    // on (workspace_id, provider_permalink) too — checking here gives
    // a friendly error instead of a constraint violation.
    const { data: existingPermalink } = await supabase
      .from("publish_history")
      .select("id, finished_at, execution_item_id")
      .eq("workspace_id", workspaceId)
      .eq("provider_permalink", parsed.normalizedUrl)
      .maybeSingle();
    if (existingPermalink) {
      return actionFail(
        `Permalink already recorded (history id ${(existingPermalink as { id: string }).id} on ${(existingPermalink as { finished_at: string }).finished_at}).`,
      );
    }

    // Run the manual-publish policy.
    const { evaluateManualPublishPolicy } = await import(
      "@/core/publishing/manual-publish-policy"
    );
    const verdict = await evaluateManualPublishPolicy({
      supabase,
      workspaceId,
      executionItem: {
        id: item.id,
        accountId: item.accountId,
        productId: item.productId,
        platform: item.platform,
        title: item.title,
        body: item.body,
        linkUrl: item.linkUrl,
        scheduledAt: item.scheduledAt,
        actionType: item.actionType,
        metadata: item.metadata as Record<string, unknown>,
      },
      confirmationPhrase,
      subreddit: subredditRaw,
      nowIso,
    });
    const fp = await computeFingerprint({
      platform: "reddit",
      subreddit: subredditRaw,
      title: item.title,
      body: item.body,
      linkUrl: item.linkUrl,
    });
    if (!verdict.ok) {
      await insertPublishHistory({
        workspaceId,
        executionItemId: item.id,
        accountId: item.accountId,
        productId: item.productId,
        platform: "reddit",
        subreddit: subredditRaw,
        fingerprint: fp.fingerprint,
        titleHash: fp.titleHash,
        bodyHash: fp.bodyHash,
        linkUrl: item.linkUrl,
        providerPostId: null,
        providerPermalink: null,
        outcome: "blocked",
        mode: "manual",
        reasonCode: verdict.reasonCode,
        httpStatus: null,
        startedAt: nowIso,
        metadata: {
          publish_method: "manual",
          detail: verdict.reasonDetail ?? null,
        },
      });
      await recordLog({
        workspaceId,
        queueId: item.queueId,
        executionItemId: item.id,
        eventType: "item.blocked",
        severity: "error",
        message: `[manual-publish] blocked — ${verdict.reasonCode}: ${verdict.reasonDetail}`,
        metadata: {
          reason_code: verdict.reasonCode,
          publish_method: "manual",
        },
      });
      return actionFail(verdict.reasonDetail ?? "Policy refused publish.");
    }

    // Walk ready → running → completed.
    await updateItemStatus({
      workspaceId,
      itemId: item.id,
      to: "running",
    });

    await insertPublishHistory({
      workspaceId,
      executionItemId: item.id,
      accountId: item.accountId,
      productId: item.productId,
      platform: "reddit",
      subreddit: subredditRaw,
      fingerprint: fp.fingerprint,
      titleHash: fp.titleHash,
      bodyHash: fp.bodyHash,
      linkUrl: item.linkUrl,
      providerPostId: parsed.providerPostId,
      providerPermalink: parsed.normalizedUrl,
      outcome: "published",
      mode: "manual",
      reasonCode: null,
      httpStatus: null, // no API round-trip on the manual path
      startedAt: nowIso,
      metadata: {
        publish_method: "manual",
        operator_notes: operatorNotes,
      },
    });
    await updateItemStatus({
      workspaceId,
      itemId: item.id,
      to: "completed",
      patch: {
        metadata: {
          ...(item.metadata as Record<string, unknown>),
          publish_outcome: {
            status: "published",
            publish_method: "manual",
            external_id: parsed.providerPostId,
            external_url: parsed.normalizedUrl,
            published_at: new Date().toISOString(),
          },
        },
      },
    });
    const planItemId =
      (item.metadata as { plan_item_id?: string })?.plan_item_id ?? null;
    if (planItemId) {
      try {
        await updatePlanItemStatus({
          workspaceId,
          itemId: planItemId,
          status: "published",
        });
      } catch (err) {
        console.error("[recordManualPublishAction] plan_item mirror failed", err);
      }
    }
    await recordLog({
      workspaceId,
      queueId: item.queueId,
      executionItemId: item.id,
      eventType: "item.completed",
      severity: "info",
      message: `[manual-publish] recorded — ${parsed.normalizedUrl}`,
      metadata: {
        permalink: parsed.normalizedUrl,
        provider_post_id: parsed.providerPostId,
        subreddit: subredditRaw,
        publish_method: "manual",
      },
    });
    try {
      await recordActivity({
        workspaceId,
        eventType: "manual_publish.recorded",
        entityType: "execution_item",
        entityId: item.id,
        title: `Manual publish recorded — r/${subredditRaw}`,
        description: parsed.normalizedUrl,
        metadata: {
          permalink: parsed.normalizedUrl,
          provider_post_id: parsed.providerPostId,
          publish_method: "manual",
          mode: "manual",
          operator_notes: operatorNotes,
        },
      });
    } catch (err) {
      console.error("[recordManualPublishAction] activity log failed", err);
    }
    revalidatePath("/execution");
    revalidatePath(`/execution/${item.queueId}`);
    revalidatePath(`/execution/items/${item.id}`);
    revalidatePath("/weekly-plan");
    revalidatePath("/activity");
    return actionOk({
      executionItemId: item.id,
      permalink: parsed.normalizedUrl,
      providerPostId: parsed.providerPostId,
    });
  } catch (err) {
    const msg =
      err instanceof RepositoryError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Manual publish record failed.";
    console.error("[recordManualPublishAction] failed", err);
    return actionFail(msg);
  }
}
