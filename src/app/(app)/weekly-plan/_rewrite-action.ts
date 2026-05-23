"use server";
/**
 * Phase F4.6 — rewriteDraftAction.
 *
 * Founder-facing server action invoked by the rewrite chips on the
 * compose sheet. Loads the plan item, calls rewriteDraft (which
 * dispatches to the configured AI provider), and updates the
 * weekly_plan_items row in place.
 *
 * Sequence:
 *   1. Workspace + item ownership.
 *   2. Refuse if status is published / rejected / backlog.
 *   3. Refuse if no AI provider configured (founder-readable).
 *   4. Call rewriteDraft.
 *   5. On safety refusal: don't touch the row; return calm copy.
 *   6. On success: update title (for improve_headline) or body,
 *      bump rewrite_count and last_rewrite_* metadata.
 *
 * Drafts NEVER change status as a side-effect of a rewrite — the
 * founder remains the only path to scheduled/published.
 */

import { revalidatePath } from "next/cache";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import {
  getPlanItemById,
  updatePlanItem,
} from "@/repositories/weekly-plan-repository";
import { recordActivity } from "@/repositories/activity-repository";
import { rewriteDraft } from "@/core/generation/rewrite-draft";
import {
  isRewriteAction,
  REWRITE_ACTION_LABELS,
  type RewriteAction,
} from "@/core/generation/rewrite-types";
import {
  friendlyGenerationFailure,
  type GenerationFailureReason,
} from "@/core/generation/founder-error";
import {
  checkWorkspaceAiUsage,
  usageLimitMessage,
} from "@/core/generation/usage-limit";
import { RepositoryError } from "@/repositories/errors";
import {
  actionFail,
  actionOk,
  type ActionResult,
} from "@/lib/forms/action-result";

export type RewriteDraftActionResult = ActionResult<{
  itemId: string;
  action: RewriteAction;
  providerLabel: string;
  durationMs: number;
  truncated: boolean;
  /** New title after the rewrite (only set for improve_headline). */
  newTitle: string | null;
  /** New body after the rewrite (set for everything except improve_headline). */
  newBody: string | null;
  /** Whether an undo snapshot was persisted for this rewrite. */
  undoAvailable: boolean;
}>;

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Claude",
  openai: "OpenAI",
};

export async function rewriteDraftAction(
  _prev: RewriteDraftActionResult,
  formData: FormData,
): Promise<RewriteDraftActionResult> {
  const itemId = String(formData.get("item_id") ?? "").trim();
  const actionRaw = String(formData.get("action") ?? "").trim();
  if (!itemId) return actionFail("Missing item.");
  if (!isRewriteAction(actionRaw)) {
    return actionFail("Unknown rewrite action.");
  }
  const action = actionRaw;

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const workspaceId = membership.workspace.id;

    const existing = await getPlanItemById(workspaceId, itemId);
    if (
      existing.status === "published" ||
      existing.status === "rejected" ||
      existing.status === "backlog"
    ) {
      return actionFail(
        "This post can't be rewritten in its current state. Duplicate it first if you want a new draft.",
      );
    }
    if (!existing.body || existing.body.trim().length === 0) {
      const friendly = friendlyGenerationFailure("no_body");
      return actionFail(`${friendly.title} ${friendly.advice}`);
    }

    // Identity is required for voice context. If the item has no
    // account_id, we can still rewrite, but we use a fallback. The
    // rewriteDraft entry point handles this by returning
    // provider_unavailable when context lookup fails.
    if (!existing.accountId) {
      return actionFail(
        "This post has no publishing identity attached. Set one in the compose sheet before rewriting.",
      );
    }

    // F4.6.1 — workspace-level rolling 24h limit. Checked BEFORE
    // calling the provider so we don't burn API quota on a request
    // we'd refuse anyway. Counts both successful and failed AI
    // actions in the window; undo isn't counted.
    const usage = await checkWorkspaceAiUsage(workspaceId);
    if (usage.exceeded) {
      return actionFail(usageLimitMessage(usage));
    }

    const result = await rewriteDraft({
      workspaceId,
      identityId: existing.accountId,
      itemId: existing.id,
      currentTitle: existing.title,
      currentBody: existing.body,
      platform: existing.platform ?? "reddit",
      action,
    });

    if (!result.ok) {
      const friendly = friendlyGenerationFailure(
        result.reason as GenerationFailureReason,
      );
      return actionFail(`${friendly.title} ${friendly.advice}`);
    }

    // Apply the rewrite. Metadata-only: bump rewrite count + record
    // which action ran, which provider answered, and how long it
    // took. NO prompt body, NO raw response, NO tokens.
    //
    // F4.6.1 — snapshot the previous title + body so the founder
    // can Undo the latest rewrite. Only one level of undo is
    // supported; the previous_* slot is overwritten on every new
    // rewrite. Cleared by undoRewriteAction.
    const prevMeta = existing.metadata as Record<string, unknown>;
    const prevRewriteCount =
      typeof prevMeta?.rewrite_count === "number"
        ? (prevMeta.rewrite_count as number)
        : 0;
    const nextMeta: Record<string, unknown> = {
      ...prevMeta,
      rewrite_count: prevRewriteCount + 1,
      last_rewrite_action: action,
      last_rewrite_provider: result.providerName,
      last_rewrite_duration_ms: result.durationMs,
      last_rewrite_at: new Date().toISOString(),
      last_rewrite_truncated: result.truncated,
      previous_title_before_rewrite: existing.title,
      previous_body_before_rewrite: existing.body,
      previous_rewrite_action: action,
      previous_rewrite_timestamp: new Date().toISOString(),
    };

    if (result.newTitle) {
      await updatePlanItem({
        workspaceId,
        itemId: existing.id,
        patch: {
          title: result.newTitle,
          metadata: nextMeta,
        },
      });
    } else if (result.newBody) {
      await updatePlanItem({
        workspaceId,
        itemId: existing.id,
        patch: {
          body: result.newBody,
          metadata: nextMeta,
        },
      });
    }

    try {
      await recordActivity({
        workspaceId,
        eventType: "draft.rewritten",
        entityType: "weekly_plan_item",
        entityId: existing.id,
        title: `Draft rewritten — ${REWRITE_ACTION_LABELS[action]}`,
        description: `${PROVIDER_LABELS[result.providerName] ?? result.providerName} · ${result.durationMs}ms`,
        metadata: {
          action,
          provider: result.providerName,
          duration_ms: result.durationMs,
          truncated: result.truncated,
        },
      });
    } catch (err) {
      console.error("[rewriteDraftAction] activity log failed", err);
    }

    revalidatePath("/weekly-plan");
    return actionOk({
      itemId: existing.id,
      action,
      providerLabel:
        PROVIDER_LABELS[result.providerName] ?? result.providerName,
      durationMs: result.durationMs,
      truncated: result.truncated,
      newTitle: result.newTitle,
      newBody: result.newBody,
      undoAvailable: true,
    });
  } catch (error) {
    const message =
      error instanceof RepositoryError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Couldn't rewrite this draft.";
    console.error("[rewriteDraftAction] failed", error);
    return actionFail(message);
  }
}
