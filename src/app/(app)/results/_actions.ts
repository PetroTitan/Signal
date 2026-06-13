"use server";

import { revalidatePath } from "next/cache";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { getPublishHistoryById } from "@/repositories/publish-history-repository";
import { refreshPostMetrics } from "@/core/metrics/refresh-metrics";
import { actionFail, actionOk, type ActionResult } from "@/lib/forms/action-result";

/**
 * C3.6 — manual metrics refresh for one published post. Fetches verified
 * provider counts and updates the cache. Never fabricates values; an
 * unsupported/unavailable platform simply records that status.
 */
export async function refreshResultMetricsAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const publishHistoryId = String(formData.get("publish_history_id") ?? "").trim();
  if (!publishHistoryId) return actionFail("Missing post id.");
  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const workspaceId = membership.workspace.id;

    const row = await getPublishHistoryById(workspaceId, publishHistoryId);
    if (!row) return actionFail("Published post not found.");
    if (row.outcome !== "published") {
      return actionFail("Only published posts have metrics.");
    }

    await refreshPostMetrics({
      workspaceId,
      publishHistoryId,
      platform: row.platform,
      externalPostId: row.providerPostId,
      permalink: row.providerPermalink,
    });
    revalidatePath("/results");
    return actionOk();
  } catch (err) {
    console.error("[results] refreshResultMetricsAction failed", err);
    return actionFail("Could not refresh metrics.");
  }
}
