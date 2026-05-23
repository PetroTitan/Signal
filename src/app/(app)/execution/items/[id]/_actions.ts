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
