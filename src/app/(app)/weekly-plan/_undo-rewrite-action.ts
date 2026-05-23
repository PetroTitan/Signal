"use server";
/**
 * Phase F4.6.1 — undo the latest AI rewrite.
 *
 * Restores the snapshot saved by rewriteDraftAction:
 *   previous_title_before_rewrite
 *   previous_body_before_rewrite
 *   previous_rewrite_action
 *   previous_rewrite_timestamp
 *
 * Only one level of undo is supported per the brief ("undo only the
 * latest rewrite"). After a successful undo the snapshot keys are
 * cleared so a stale state can't be undone a second time.
 *
 * Undo is FREE — it doesn't count against the workspace AI usage
 * limit. It's also not gated by status the same way rewrite is —
 * approved/scheduled items can still be reverted to a previous
 * body, since the founder is choosing to discard the rewrite, not
 * to publish anything new.
 */

import { revalidatePath } from "next/cache";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import {
  getPlanItemById,
  updatePlanItem,
} from "@/repositories/weekly-plan-repository";
import { recordActivity } from "@/repositories/activity-repository";
import { RepositoryError } from "@/repositories/errors";
import {
  actionFail,
  actionOk,
  type ActionResult,
} from "@/lib/forms/action-result";

export type UndoRewriteActionResult = ActionResult<{
  itemId: string;
  newTitle: string | null;
  newBody: string | null;
}>;

export async function undoRewriteAction(
  _prev: UndoRewriteActionResult,
  formData: FormData,
): Promise<UndoRewriteActionResult> {
  const itemId = String(formData.get("item_id") ?? "").trim();
  if (!itemId) return actionFail("Missing item.");

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const workspaceId = membership.workspace.id;

    const existing = await getPlanItemById(workspaceId, itemId);
    if (existing.status === "published") {
      return actionFail(
        "This post is already published — the previous version isn't recoverable from here.",
      );
    }

    const meta = existing.metadata as Record<string, unknown>;
    const hasTitleSnapshot =
      Object.prototype.hasOwnProperty.call(meta, "previous_title_before_rewrite");
    const hasBodySnapshot =
      Object.prototype.hasOwnProperty.call(meta, "previous_body_before_rewrite");
    if (!hasTitleSnapshot && !hasBodySnapshot) {
      return actionFail("There's no rewrite to undo.");
    }

    const previousTitle =
      typeof meta.previous_title_before_rewrite === "string"
        ? (meta.previous_title_before_rewrite as string)
        : null;
    const previousBody =
      typeof meta.previous_body_before_rewrite === "string"
        ? (meta.previous_body_before_rewrite as string)
        : null;
    const previousAction =
      typeof meta.previous_rewrite_action === "string"
        ? (meta.previous_rewrite_action as string)
        : null;

    // Decide which fields the original rewrite changed and restore
    // only those. If both title and body have snapshots, restore
    // both (some actions could in principle touch both, even though
    // the current rewrite-draft only touches one at a time).
    const patch: { title?: string | null; body?: string | null } = {};
    if (hasTitleSnapshot) patch.title = previousTitle;
    if (hasBodySnapshot) patch.body = previousBody;

    // Clear the snapshot keys + flag that the latest rewrite was
    // undone. The rewrite_count metric is left as-is — it reflects
    // historical AI activity, not the current state.
    const nextMeta: Record<string, unknown> = { ...meta };
    delete nextMeta.previous_title_before_rewrite;
    delete nextMeta.previous_body_before_rewrite;
    delete nextMeta.previous_rewrite_action;
    delete nextMeta.previous_rewrite_timestamp;
    nextMeta.last_rewrite_undone_at = new Date().toISOString();
    nextMeta.last_rewrite_undone_action = previousAction;

    await updatePlanItem({
      workspaceId,
      itemId: existing.id,
      patch: {
        ...patch,
        metadata: nextMeta,
      },
    });

    try {
      await recordActivity({
        workspaceId,
        eventType: "draft.rewrite_undone",
        entityType: "weekly_plan_item",
        entityId: existing.id,
        title: "Rewrite reverted",
        description: previousAction
          ? `Undid: ${previousAction}.`
          : "Restored the previous version.",
        metadata: { undone_action: previousAction },
      });
    } catch (err) {
      console.error("[undoRewriteAction] activity log failed", err);
    }

    revalidatePath("/weekly-plan");
    return actionOk({
      itemId: existing.id,
      newTitle: hasTitleSnapshot ? previousTitle : null,
      newBody: hasBodySnapshot ? previousBody : null,
    });
  } catch (error) {
    const message =
      error instanceof RepositoryError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Couldn't undo the rewrite.";
    console.error("[undoRewriteAction] failed", error);
    return actionFail(message);
  }
}
