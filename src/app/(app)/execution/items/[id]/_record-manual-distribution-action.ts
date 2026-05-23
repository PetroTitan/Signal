"use server";
/**
 * Phase F5.0 — record-manual-distribution action.
 *
 * Handles the "founder posted on X/LinkedIn, here's the permalink"
 * step of the manual distribution flow. Parallels the F2.6 Reddit
 * recordManualPublishAction but without Reddit's subreddit gating.
 *
 * Sequence:
 *   1. Validate permalink shape (light per-platform check).
 *   2. Verify workspace + execution-item ownership.
 *   3. Refuse unless status is 'ready' or 'ready_for_manual_publish'.
 *   4. Refuse if the permalink is already in publish_history.
 *   5. Compute fingerprint and write a manual-mode publish_history row.
 *   6. Walk execution_item → completed.
 *   7. Mirror weekly_plan_items.status = 'published'.
 *
 * No platform API is called. The founder hand-posted on X or
 * LinkedIn; Signal just records the outcome so the publish history
 * stays unified.
 */

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
import { computeFingerprint } from "@/core/publishing/publish-fingerprint";
import { RepositoryError } from "@/repositories/errors";
import {
  actionFail,
  actionOk,
  type ActionResult,
} from "@/lib/forms/action-result";

export type ManualDistributionPlatform =
  | "x"
  | "linkedin"
  | "youtube"
  | "threads"
  | "instagram";

export type RecordManualDistributionResult = ActionResult<{
  executionItemId: string;
  permalink: string;
  platform: ManualDistributionPlatform;
}>;

const X_HOST_RE = /^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\//i;
const LINKEDIN_HOST_RE = /^https?:\/\/(?:www\.)?linkedin\.com\//i;
const YOUTUBE_HOST_RE =
  /^https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch|shorts|embed|live)|youtu\.be\/)/i;
const THREADS_HOST_RE = /^https?:\/\/(?:www\.)?threads\.(?:net|com)\//i;
const INSTAGRAM_HOST_RE = /^https?:\/\/(?:www\.)?instagram\.com\//i;

function validatePermalinkForPlatform(
  platform: ManualDistributionPlatform,
  url: string,
): string | null {
  switch (platform) {
    case "x":
      return X_HOST_RE.test(url)
        ? null
        : "That doesn't look like an X permalink. Expected an x.com or twitter.com URL.";
    case "linkedin":
      return LINKEDIN_HOST_RE.test(url)
        ? null
        : "That doesn't look like a LinkedIn permalink. Expected a linkedin.com URL.";
    case "youtube":
      return YOUTUBE_HOST_RE.test(url)
        ? null
        : "That doesn't look like a YouTube permalink. Expected a youtube.com or youtu.be URL.";
    case "threads":
      return THREADS_HOST_RE.test(url)
        ? null
        : "That doesn't look like a Threads permalink. Expected a threads.net URL.";
    case "instagram":
      return INSTAGRAM_HOST_RE.test(url)
        ? null
        : "That doesn't look like an Instagram permalink. Expected an instagram.com URL.";
  }
}

function isManualDistributionPlatform(
  value: string,
): value is ManualDistributionPlatform {
  return (
    value === "x" ||
    value === "linkedin" ||
    value === "youtube" ||
    value === "threads" ||
    value === "instagram"
  );
}

function normalizeUrl(raw: string): string {
  // Strip trailing punctuation that often comes along with a paste.
  return raw.trim().replace(/[.,;:!?)\]]+$/g, "");
}

export async function recordManualDistributionAction(
  _prev: RecordManualDistributionResult,
  formData: FormData,
): Promise<RecordManualDistributionResult> {
  const executionItemId = String(formData.get("execution_item_id") ?? "").trim();
  const platformRaw = String(formData.get("platform") ?? "").trim();
  const permalinkRaw = String(formData.get("permalink") ?? "").trim();
  const operatorNotes =
    String(formData.get("operator_notes") ?? "").trim() || null;

  if (!executionItemId) return actionFail("Missing execution item.");
  if (!isManualDistributionPlatform(platformRaw)) {
    return actionFail(
      "This action only handles X, LinkedIn, YouTube, Threads, and Instagram.",
    );
  }
  const platform = platformRaw;

  const permalink = normalizeUrl(permalinkRaw);
  if (permalink.length === 0) {
    return actionFail("Paste the permalink of the post you published.");
  }
  const permalinkError = validatePermalinkForPlatform(platform, permalink);
  if (permalinkError) {
    return actionFail(permalinkError);
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
        `This post isn't ready to record yet (current state: ${item.status}).`,
      );
    }
    if (item.platform !== platform) {
      return actionFail(
        `Mismatch: the post is targeted at ${item.platform ?? "(no platform)"} but you're recording a ${platform} URL.`,
      );
    }

    const supabase = createSupabaseServerClient();
    const nowIso = new Date().toISOString();

    // Duplicate-permalink guard. The DB has a partial unique index on
    // (workspace_id, provider_permalink) — checking here gives a calm
    // error instead of a constraint violation.
    const { data: existingPermalink } = await supabase
      .from("publish_history")
      .select("id, finished_at")
      .eq("workspace_id", workspaceId)
      .eq("provider_permalink", permalink)
      .maybeSingle();
    if (existingPermalink) {
      return actionFail(
        "This permalink is already recorded. Each post can only be recorded once.",
      );
    }

    const fp = await computeFingerprint({
      platform,
      subreddit: null,
      title: item.title,
      body: item.body,
      linkUrl: item.linkUrl,
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
      providerPermalink: permalink,
      outcome: "published",
      mode: "manual",
      reasonCode: null,
      httpStatus: null,
      startedAt: nowIso,
      metadata: {
        ...(operatorNotes ? { operator_notes: operatorNotes } : {}),
        distribution_method: "manual",
        manual_distribution_verified: true,
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
            mode: "manual",
            permalink,
            recorded_at: nowIso,
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
        console.error(
          "[recordManualDistributionAction] plan_item mirror failed",
          err,
        );
      }
    }

    try {
      await recordLog({
        workspaceId,
        queueId: item.queueId,
        executionItemId: item.id,
        eventType: "item.completed",
        severity: "info",
        message: `[manual:${platform}] recorded — ${permalink}`,
        metadata: { permalink, platform, mode: "manual" },
      });
    } catch (err) {
      console.error("[recordManualDistributionAction] log failed", err);
    }

    try {
      const friendly: Record<ManualDistributionPlatform, string> = {
        x: "X",
        linkedin: "LinkedIn",
        youtube: "YouTube",
        threads: "Threads",
        instagram: "Instagram",
      };
      await recordActivity({
        workspaceId,
        eventType: `${platform}.post_published`,
        entityType: "execution_item",
        entityId: item.id,
        title: `${friendly[platform]} post recorded`,
        description: permalink,
        metadata: {
          permalink,
          mode: "manual",
          distribution_method: "manual",
          manual_distribution_verified: true,
        },
      });
    } catch (err) {
      console.error("[recordManualDistributionAction] activity failed", err);
    }

    revalidatePath("/dashboard");
    revalidatePath("/weekly-plan");
    revalidatePath("/execution");
    revalidatePath(`/execution/items/${item.id}`);
    return actionOk({
      executionItemId: item.id,
      permalink,
      platform,
    });
  } catch (error) {
    const message =
      error instanceof RepositoryError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Couldn't record this post.";
    console.error("[recordManualDistributionAction] failed", error);
    return actionFail(message);
  }
}
