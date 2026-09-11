import "server-only";
/**
 * MCP read tools for Bluesky relationships.
 *
 * READ-ONLY, and structurally so. Relationship WRITE tools are out of
 * scope for this milestone and deliberately so: a follow acts as the
 * operator's account in public, and "explicitly initiated by the
 * operator" is not a property an agent tool call can carry. These three
 * tools answer questions; none creates a batch, none mutates a
 * relationship, and none returns anything an agent could mistake for an
 * instruction to act.
 *
 * Why only three: an MCP tool earns its place by answering a question
 * an operator would otherwise open a dashboard for. "What is the state
 * of my imports", "how many candidates are in which state", and "what
 * happened to this account" are those questions. A tool per table would
 * not be.
 *
 * `ctx.db` is the service-role client and bypasses RLS, so every query
 * below filters on `ctx.workspaceId` explicitly. That is the same rule
 * the rest of the MCP surface follows and the workspace-isolation test
 * covers.
 */

import type { ToolContext } from "../tool-context";
import { failed, ok, type McpToolResponse } from "../responses";
import { describeImportProgress } from "@/core/bluesky-relationships/import-plan";
import { relationshipLabel } from "@/core/bluesky-relationships/relationship-state";
import type {
  BlueskyCandidateRow,
  BlueskyImportRunRow,
  BlueskyRelationshipActionRow,
  BlueskyRelationshipState,
  BlueskyTargetProfileRow,
} from "@/lib/supabase/types";

/** Warnings every relationship tool carries, so no caller has to infer them. */
const STANDARD_WARNINGS = [
  "Read-only. These tools cannot follow, unfollow, protect, or start a batch.",
  "Relationship state is Signal's last observation, not a live read. `unknown` means the state was never checked or a lookup failed — it does not mean 'not following'.",
];

/** Target profiles and how far each import has actually got. */
export async function relationshipTargets(
  ctx: ToolContext,
): Promise<McpToolResponse> {
  const tool = "signal.bluesky.relationship_targets";
  try {
    const { data: targets, error } = await ctx.db
      .from("bluesky_target_profiles")
      .select("*")
      .eq("workspace_id", ctx.workspaceId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);

    const rows = (targets ?? []) as unknown as BlueskyTargetProfileRow[];
    const described = [];
    let incomplete = 0;

    for (const target of rows) {
      const { data: runs } = await ctx.db
        .from("bluesky_import_runs")
        .select("*")
        .eq("workspace_id", ctx.workspaceId)
        .eq("target_profile_id", target.id)
        .order("created_at", { ascending: false })
        .limit(1);
      const run = ((runs ?? []) as unknown as BlueskyImportRunRow[])[0] ?? null;

      // Completeness is both conditions, never the status alone.
      const complete = run?.status === "completed" && run.cursor_exhausted;
      if (!complete) incomplete += 1;

      described.push({
        targetId: target.id,
        did: target.subject_did,
        handle: target.handle,
        displayName: target.display_name,
        followersOnBluesky: target.followers_count,
        importStatus: run?.status ?? "not_started",
        followersImported: run?.followers_seen ?? 0,
        cursorExhausted: run?.cursor_exhausted ?? false,
        complete,
        progress: run
          ? describeImportProgress({
              status: run.status,
              cursorExhausted: run.cursor_exhausted,
              followersSeen: run.followers_seen,
              stopReason: run.stop_reason,
            })
          : "Not started.",
        lastError: run?.last_error ?? null,
      });
    }

    return ok({
      tool,
      summary:
        rows.length === 0
          ? "No Bluesky target profiles have been added."
          : `${rows.length} target profile(s); ${incomplete} import(s) not yet complete.`,
      data: { targets: described },
      warnings: [
        ...STANDARD_WARNINGS,
        "An import is complete only when Bluesky stopped returning a pagination cursor. A target whose `complete` is false has more followers to import, however many are already stored.",
      ],
    });
  } catch (err) {
    return failed({
      tool,
      summary: err instanceof Error ? err.message : "unavailable",
    });
  }
}

/** How the candidate corpus breaks down by observed relationship state. */
export async function relationshipSummary(
  ctx: ToolContext,
): Promise<McpToolResponse> {
  const tool = "signal.bluesky.relationship_summary";
  try {
    const { data, error } = await ctx.db
      .from("bluesky_candidates")
      .select("relationship_state, protected, operator_account_id")
      .eq("workspace_id", ctx.workspaceId);
    if (error) throw new Error(error.message);

    const rows = (data ?? []) as unknown as Pick<
      BlueskyCandidateRow,
      "relationship_state" | "protected" | "operator_account_id"
    >[];

    const byState: Record<string, number> = {};
    for (const state of [
      "unknown",
      "not_following",
      "following",
      "follows_you",
      "mutual",
    ] as BlueskyRelationshipState[]) {
      byState[state] = rows.filter((r) => r.relationship_state === state).length;
    }

    const { data: pending } = await ctx.db
      .from("bluesky_relationship_actions")
      .select("status")
      .eq("workspace_id", ctx.workspaceId)
      .in("status", ["pending", "running", "reconciliation_required"]);
    const openActions = (pending ?? []) as unknown as { status: string }[];

    const warnings = [...STANDARD_WARNINGS];
    if (byState.unknown > 0) {
      warnings.push(
        `${byState.unknown} candidate(s) have an unknown relationship. They are not confirmed as un-followed and must not be treated as such.`,
      );
    }
    const needsReconciliation = openActions.filter(
      (a) => a.status === "reconciliation_required",
    ).length;
    if (needsReconciliation > 0) {
      warnings.push(
        `${needsReconciliation} action(s) need reconciliation: Bluesky did not confirm the outcome, Signal read the relationship and stopped. Whether to act again is the operator's decision.`,
      );
    }

    return ok({
      tool,
      summary:
        rows.length === 0
          ? "No Bluesky candidates have been imported."
          : `${rows.length} candidate(s): ${byState.following} following, ${byState.mutual} mutual, ${byState.follows_you} follow you, ${byState.unknown} unknown.`,
      data: {
        totalCandidates: rows.length,
        byState,
        protectedCount: rows.filter((r) => r.protected).length,
        identitiesWithCandidates: new Set(rows.map((r) => r.operator_account_id))
          .size,
        openActions: openActions.length,
        needsReconciliation,
      },
      warnings,
    });
  } catch (err) {
    return failed({
      tool,
      summary: err instanceof Error ? err.message : "unavailable",
    });
  }
}

/**
 * The audit trail. Optionally narrowed to one DID.
 *
 * Returns `subject_handle_at_action` — the handle as it was when the
 * operator acted — rather than the account's current handle, because
 * the record is of what happened, not of what is true now.
 */
export async function relationshipHistory(
  ctx: ToolContext,
  args: { subjectDid?: string; limit?: number },
): Promise<McpToolResponse> {
  const tool = "signal.bluesky.relationship_history";
  try {
    let query = ctx.db
      .from("bluesky_relationship_actions")
      .select("*")
      .eq("workspace_id", ctx.workspaceId);
    if (args.subjectDid) query = query.eq("subject_did", args.subjectDid);

    const { data, error } = await query
      .order("requested_at", { ascending: false })
      .limit(Math.min(Math.max(args.limit ?? 50, 1), 200));
    if (error) throw new Error(error.message);

    const rows = (data ?? []) as unknown as BlueskyRelationshipActionRow[];
    return ok({
      tool,
      summary:
        rows.length === 0
          ? "No relationship actions recorded."
          : `${rows.length} relationship action(s), most recent first.`,
      data: {
        actions: rows.map((a) => ({
          id: a.id,
          actionType: a.action_type,
          status: a.status,
          did: a.subject_did,
          handleAtAction: a.subject_handle_at_action,
          actorDid: a.actor_did,
          actorHandleAtAction: a.actor_handle_at_action,
          batchId: a.batch_id,
          initiatorKind: a.initiator_kind,
          sourceTargetProfileIds: a.source_target_profile_ids,
          requestedAt: a.requested_at,
          finishedAt: a.finished_at,
          reconciledState: a.reconciled_state
            ? relationshipLabel(a.reconciled_state)
            : null,
          reconciliationNote: a.reconciliation_note,
          providerError: a.provider_error_message,
        })),
      },
      warnings: [
        ...STANDARD_WARNINGS,
        "Handles are recorded as they appeared at the time of the action. An account that has since renamed is still listed under its old handle here, by design.",
        "History is append-only: an unfollow adds a record, it does not retract the follow that preceded it.",
      ],
    });
  } catch (err) {
    return failed({
      tool,
      summary: err instanceof Error ? err.message : "unavailable",
    });
  }
}
