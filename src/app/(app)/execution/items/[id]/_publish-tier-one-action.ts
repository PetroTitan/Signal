"use server";
/**
 * Phase F4.2 — tier-1 (dev.to / Hashnode / Bluesky) publish action.
 *
 * Sequence:
 *   1. Verify workspace + item ownership.
 *   2. Refuse if status isn't 'ready'.
 *   3. Compute fingerprint + check publish_history for duplicate
 *      (30-day window, outcome='published' only).
 *   4. Walk execution_item ready → running.
 *   5. Call runPublish — the runner reads env credentials and
 *      dispatches to the right tier-1 adapter.
 *   6. Persist outcome to publish_history (always — published,
 *      failed, or blocked).
 *   7. Walk execution_item to completed or failed.
 *   8. Mirror weekly_plan_items.status = 'published' on success.
 *
 * Tier-1 platforms use env credentials, not OAuth tokens. The
 * runner reads them at dispatch time and never returns them.
 */

import { revalidatePath } from "next/cache";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import {
  getExecutionItemById,
  updateItemStatus,
} from "@/repositories/execution-item-repository";
import { recordLog } from "@/repositories/execution-log-repository";
import { updatePlanItemStatus } from "@/repositories/weekly-plan-repository";
import { recordActivity } from "@/repositories/activity-repository";
import {
  findRecentDuplicate,
  insertPublishHistory,
} from "@/repositories/publish-history-repository";
import { computeFingerprint } from "@/core/publishing/publish-fingerprint";
import { runPublish } from "@/core/publishing/publishing-runner";
import { friendlyFailure } from "@/core/publishing/founder-error";
import type { PublishPlatform } from "@/core/publishing/publishing-types";
import {
  actionFail,
  actionOk,
  type ActionResult,
} from "@/lib/forms/action-result";

export type PublishTierOneResult = ActionResult<{
  executionItemId: string;
  permalink: string | null;
  providerPostId: string | null;
}>;

const DUPLICATE_WINDOW_DAYS = 30;

function isTierOnePlatform(p: string): p is "devto" | "hashnode" | "bluesky" {
  return p === "devto" || p === "hashnode" || p === "bluesky";
}

export async function publishTierOneAction(
  _prev: PublishTierOneResult,
  formData: FormData,
): Promise<PublishTierOneResult> {
  const executionItemId = String(
    formData.get("execution_item_id") ?? "",
  ).trim();
  if (!executionItemId) return actionFail("Missing execution_item_id.");

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const workspaceId = membership.workspace.id;

    const item = await getExecutionItemById(workspaceId, executionItemId);

    if (!item.platform || !isTierOnePlatform(item.platform)) {
      return actionFail(
        "This post isn't targeted at a tier-1 platform (dev.to / Hashnode / Bluesky).",
      );
    }
    const platform: PublishPlatform = item.platform;

    if (item.status !== "ready") {
      return actionFail(
        `This post isn't ready yet (current state: ${item.status}). It needs to be approved and scheduled first.`,
      );
    }
    if (!item.title || item.title.trim().length === 0) {
      return actionFail("This post needs a title before publishing.");
    }
    if (!item.body || item.body.trim().length === 0) {
      return actionFail("This post needs a body before publishing.");
    }

    const nowIso = new Date().toISOString();
    const fp = await computeFingerprint({
      platform,
      subreddit: null,
      title: item.title,
      body: item.body,
      linkUrl: item.linkUrl,
    });

    // Duplicate-content guard. Bluesky in particular benefits from this
    // because the same thread text could be re-posted accidentally.
    const sinceIso = new Date(
      Date.now() - DUPLICATE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const duplicate = await findRecentDuplicate({
      workspaceId,
      fingerprint: fp.fingerprint,
      sinceIso,
    });
    if (duplicate) {
      const friendly = friendlyFailure({
        platform,
        reasonCode: "duplicate_post",
        reasonDetail: null,
      });
      await insertPublishHistory({
        workspaceId,
        executionItemId: item.id,
        accountId: item.accountId,
        productId: item.productId,
        platform,
        subreddit: null,
        fingerprint: fp.fingerprint,
        titleHash: fp.titleHash,
        bodyHash: fp.bodyHash,
        linkUrl: item.linkUrl,
        providerPostId: null,
        providerPermalink: null,
        outcome: "blocked",
        reasonCode: "duplicate_post",
        httpStatus: null,
        startedAt: nowIso,
        metadata: { duplicate_of: duplicate.id },
      });
      return actionFail(`${friendly.title} ${friendly.advice}`);
    }

    // Walk ready → running before the API call so a hung adapter
    // doesn't leave the item stuck in 'ready' (the UI can show
    // "publishing now").
    await updateItemStatus({
      workspaceId,
      itemId: item.id,
      to: "running",
    });

    const outcome = await runPublish({
      request: {
        workspaceId,
        planItemId:
          (item.metadata as { plan_item_id?: string })?.plan_item_id ?? "",
        executionItemId: item.id,
        platform,
        accountId: item.accountId ?? "",
        productId: item.productId,
        title: item.title,
        body: item.body,
        linkUrl: item.linkUrl,
        target: null,
        mode: "live",
        // Canonical extensions — pulled from item.metadata if present.
        summary:
          (item.metadata as { summary?: string })?.summary ?? null,
        tags: Array.isArray((item.metadata as { tags?: unknown }).tags)
          ? ((item.metadata as { tags: unknown[] }).tags as string[])
          : [],
        canonicalUrl:
          (item.metadata as { canonical_url?: string })?.canonical_url ?? null,
        coverImageUrl:
          (item.metadata as { cover_image_url?: string })?.cover_image_url ??
          null,
        series:
          (item.metadata as { series?: string })?.series ?? null,
      },
      // The OAuth policy gate ignores tier-1 platforms (runner
      // short-circuits before consulting accessToken / connection),
      // so this context is mostly a placeholder. It has to type-check;
      // the publisher reads env directly.
      context: {
        hasActiveContract: true,
        accountReviewStatus: "confirmed",
        productReviewStatus: "confirmed",
        connectionStatus: null,
        hasStoredAccessToken: false,
        scheduledFor: item.scheduledAt,
        nowIso,
        publishingEnabled: true,
        riskLevel: "low",
      },
      accessToken: null,
      target: null,
    });

    const finishedAt = new Date().toISOString();
    const httpStatus =
      typeof (outcome.metadata as { http_status?: number })?.http_status ===
      "number"
        ? ((outcome.metadata as { http_status: number }).http_status as number)
        : outcome.status === "published"
          ? 200
          : null;

    if (outcome.status === "published") {
      const permalink = outcome.externalUrl ?? null;
      const providerId = outcome.externalId ?? null;

      await insertPublishHistory({
        workspaceId,
        executionItemId: item.id,
        accountId: item.accountId,
        productId: item.productId,
        platform,
        subreddit: null,
        fingerprint: fp.fingerprint,
        titleHash: fp.titleHash,
        bodyHash: fp.bodyHash,
        linkUrl: item.linkUrl,
        providerPostId: providerId,
        providerPermalink: permalink,
        outcome: "published",
        reasonCode: null,
        httpStatus,
        startedAt: nowIso,
        metadata: redactedMetadata(outcome.metadata),
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
          console.error("[publishTierOneAction] plan_item mirror failed", err);
        }
      }
      await recordLog({
        workspaceId,
        queueId: item.queueId,
        executionItemId: item.id,
        eventType: "item.completed",
        severity: "info",
        message: `[publish] published — ${permalink ?? providerId ?? "no permalink"}`,
        metadata: { permalink, provider_post_id: providerId, platform },
      });
      try {
        await recordActivity({
          workspaceId,
          eventType: `${platform}.post_published`,
          entityType: "execution_item",
          entityId: item.id,
          title: `Post published to ${friendlyLabel(platform)}`,
          description: permalink,
          metadata: { permalink, provider_post_id: providerId },
        });
      } catch (err) {
        console.error("[publishTierOneAction] activity log failed", err);
      }
      revalidatePath("/dashboard");
      revalidatePath("/execution");
      revalidatePath(`/execution/items/${item.id}`);
      return actionOk({
        executionItemId: item.id,
        permalink,
        providerPostId: providerId,
      });
    }

    // ── Failed or blocked at the adapter level.
    const failedOutcome = outcome.status === "failed" ? "failed" : "blocked";
    await insertPublishHistory({
      workspaceId,
      executionItemId: item.id,
      accountId: item.accountId,
      productId: item.productId,
      platform,
      subreddit: null,
      fingerprint: fp.fingerprint,
      titleHash: fp.titleHash,
      bodyHash: fp.bodyHash,
      linkUrl: item.linkUrl,
      providerPostId: null,
      providerPermalink: null,
      outcome: failedOutcome,
      reasonCode: outcome.reasonCode,
      httpStatus,
      startedAt: nowIso,
      metadata: { detail: outcome.reasonDetail ?? null },
    });
    await updateItemStatus({
      workspaceId,
      itemId: item.id,
      to: failedOutcome === "failed" ? "failed" : "blocked",
      patch: {
        metadata: {
          ...(item.metadata as Record<string, unknown>),
          publish_outcome: {
            status: failedOutcome,
            reason_code: outcome.reasonCode,
            reason_detail: outcome.reasonDetail,
            finished_at: finishedAt,
          },
        },
      },
    });
    await recordLog({
      workspaceId,
      queueId: item.queueId,
      executionItemId: item.id,
      eventType: failedOutcome === "failed" ? "item.failed" : "item.blocked",
      severity: "error",
      message: `[publish] ${failedOutcome} — ${outcome.reasonCode}: ${
        outcome.reasonDetail ?? "no detail"
      }`,
      metadata: { reason_code: outcome.reasonCode, platform },
    });

    const friendly = friendlyFailure({
      platform,
      reasonCode: outcome.reasonCode,
      reasonDetail: outcome.reasonDetail,
    });
    revalidatePath(`/execution/items/${item.id}`);
    return actionFail(`${friendly.title} ${friendly.advice}`);
  } catch (err) {
    console.error("[publishTierOneAction] failed", err);
    return actionFail(
      `Something went wrong while publishing. ${
        err instanceof Error ? err.message : "Unknown error."
      }`,
    );
  }
}

function redactedMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  // Strip any keys that might carry a credential or echoed token.
  // None of the tier-1 adapters return those today, but this is a
  // defensive belt for future adapters.
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (/token|key|password|secret|auth/i.test(key)) continue;
    redacted[key] = value;
  }
  return redacted;
}

function friendlyLabel(platform: PublishPlatform): string {
  switch (platform) {
    case "devto":
      return "dev.to";
    case "hashnode":
      return "Hashnode";
    case "bluesky":
      return "Bluesky";
    default:
      return platform;
  }
}
