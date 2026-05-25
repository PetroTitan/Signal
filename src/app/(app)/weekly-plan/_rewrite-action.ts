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
import { deterministicRewrite } from "@/core/generation/deterministic-rewrite";
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
  /** "ai" when an AI provider produced the rewrite; "deterministic"
   *  when the platform-native engine produced it. */
  mode: "ai" | "deterministic";
  /** Operator-readable summary of what changed. Always present in
   *  deterministic mode; null in AI mode (we don't expose the
   *  prompt). */
  receipt: string | null;
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

    // Try the AI path FIRST when there's an attached identity and
    // when usage is under quota. Any failure that means "AI isn't
    // available right now" (no provider configured, transient
    // provider error) falls through to the deterministic engine
    // rather than dead-buttoning the operator.
    let aiResult: Awaited<ReturnType<typeof rewriteDraft>> | null = null;
    if (existing.accountId) {
      const usage = await checkWorkspaceAiUsage(workspaceId);
      if (usage.exceeded) {
        // Quota exhausted: be explicit, don't silently fall through.
        return actionFail(usageLimitMessage(usage));
      }
      aiResult = await rewriteDraft({
        workspaceId,
        identityId: existing.accountId,
        itemId: existing.id,
        currentTitle: existing.title,
        currentBody: existing.body,
        platform: existing.platform ?? "reddit",
        action,
      });
    }

    // Decide the final rewrite shape.
    let newTitle: string | null = null;
    let newBody: string | null = null;
    let mode: "ai" | "deterministic" = "ai";
    let providerLabel = "";
    let durationMs = 0;
    let truncated = false;
    let receipt: string | null = null;

    if (aiResult && aiResult.ok) {
      newTitle = aiResult.newTitle;
      newBody = aiResult.newBody;
      mode = "ai";
      providerLabel =
        PROVIDER_LABELS[aiResult.providerName] ?? aiResult.providerName;
      durationMs = aiResult.durationMs;
      truncated = aiResult.truncated;
      receipt = null;
    } else if (
      !aiResult ||
      aiResult.reason === "no_provider_configured" ||
      aiResult.reason === "provider_unavailable" ||
      aiResult.reason === "empty_response"
    ) {
      // Deterministic fallback — never refuses, always either applies
      // or returns "no_change" with a calm message.
      const fallback = deterministicRewrite({
        action,
        currentTitle: existing.title,
        currentBody: existing.body,
        platform: existing.platform ?? "reddit",
      });
      if (!fallback.ok) {
        return actionFail(
          fallback.reason === "no_change"
            ? `${fallback.detail} (Advanced AI rewrite unavailable; deterministic adapter found nothing to change.)`
            : fallback.detail,
        );
      }
      newTitle = fallback.newTitle;
      newBody = fallback.newBody;
      mode = "deterministic";
      providerLabel = "Platform-native rules";
      receipt = fallback.receipt;
    } else {
      // Provider safety refusal or another non-fallback failure — surface
      // as before.
      const friendly = friendlyGenerationFailure(
        aiResult.reason as GenerationFailureReason,
      );
      return actionFail(`${friendly.title} ${friendly.advice}`);
    }

    // Apply. Metadata-only: bump rewrite count + record which action
    // ran, which mode (ai/deterministic) produced it, and how long
    // it took. NO prompt body, NO raw response, NO tokens.
    const prevMeta = existing.metadata as Record<string, unknown>;
    const prevRewriteCount =
      typeof prevMeta?.rewrite_count === "number"
        ? (prevMeta.rewrite_count as number)
        : 0;
    const nextMeta: Record<string, unknown> = {
      ...prevMeta,
      rewrite_count: prevRewriteCount + 1,
      last_rewrite_action: action,
      last_rewrite_mode: mode,
      last_rewrite_provider:
        mode === "ai" && aiResult && aiResult.ok
          ? aiResult.providerName
          : "deterministic",
      last_rewrite_duration_ms: durationMs,
      last_rewrite_at: new Date().toISOString(),
      last_rewrite_truncated: truncated,
      previous_title_before_rewrite: existing.title,
      previous_body_before_rewrite: existing.body,
      previous_rewrite_action: action,
      previous_rewrite_timestamp: new Date().toISOString(),
    };

    if (newTitle) {
      await updatePlanItem({
        workspaceId,
        itemId: existing.id,
        patch: {
          title: newTitle,
          metadata: nextMeta,
        },
      });
    } else if (newBody) {
      await updatePlanItem({
        workspaceId,
        itemId: existing.id,
        patch: {
          body: newBody,
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
        description:
          mode === "ai"
            ? `${providerLabel} · ${durationMs}ms`
            : `Deterministic adapter · ${receipt ?? ""}`,
        metadata: {
          action,
          mode,
          provider: mode === "ai" ? providerLabel : "deterministic",
          duration_ms: durationMs,
          truncated,
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
        providerLabel.length > 0 ? providerLabel : "Platform-native rules",
      durationMs,
      truncated,
      newTitle,
      newBody,
      mode,
      receipt,
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
