/**
 * Phase A1 — atomic execution-item claim.
 *
 * Double-publish protection
 * -------------------------
 * Before this module the scheduler selected `status='scheduled'` rows
 * and published them with NO claim step. Two overlapping ticks (cron +
 * manual trigger, or a tick running longer than the cron interval)
 * could both select the same row; and a function that died after the
 * provider call but before `applyOutcome` persisted left the row
 * `scheduled`, so the next tick published it AGAIN.
 *
 * The fix is a compare-and-set claim using the EXISTING status model:
 * `scheduled → running` is already a legal transition in the execution
 * state machine, and `running` rows are never selected by the tick
 * query. The claim is a single guarded UPDATE:
 *
 *     UPDATE execution_items
 *     SET status='running', metadata=…claim…
 *     WHERE id=? AND workspace_id=? AND status='scheduled'
 *     RETURNING id
 *
 * Zero rows returned ⇒ someone else claimed it (or its state moved) ⇒
 * the caller MUST skip the item. This makes the worst-case for a
 * mid-publish crash "one item stuck in `running`" (surfaced to the
 * operator as a stale claim — see attention-summary) instead of "the
 * same post published twice".
 *
 * Idempotency metadata recorded on claim (`metadata.scheduler_claim`):
 * claimed_at, claim_source, scheduler run id, plan_item_id, and the
 * content fingerprint when the caller provides one. After a successful
 * publish, `applyOutcome` already persists the provider external_id —
 * together these give an audit trail for any duplicate investigation.
 *
 * No DB migration: existing status enum + existing metadata JSONB.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface SchedulerClaimMetadata {
  claimed_at: string;
  /** "cron_tick" today; manual triggers pass their own label. */
  claim_source: string;
  /** Random id shared by every claim in one tick run. */
  scheduler_run_id: string;
  plan_item_id: string | null;
  /** Optional content fingerprint for duplicate forensics. */
  payload_fingerprint?: string | null;
}

export interface ClaimExecutionItemInput {
  /** Service-role client (the tick has no operator cookie). */
  supabase: Pick<SupabaseClient, "from">;
  workspaceId: string;
  itemId: string;
  /** The item's CURRENT metadata as read by the tick query. Merged
   *  (not replaced) so plan_item_id / contract_mode / etc. survive. */
  currentMetadata: Record<string, unknown>;
  schedulerRunId: string;
  claimSource?: string;
  nowIso?: string;
  payloadFingerprint?: string | null;
}

export type ClaimExecutionItemResult =
  | {
      claimed: true;
      /** metadata as persisted (caller threads this into applyOutcome
       *  so the terminal write doesn't clobber the claim record). */
      metadata: Record<string, unknown>;
    }
  | { claimed: false; reason: "already_claimed_or_moved" | "claim_error"; detail?: string };

export async function claimExecutionItem(
  input: ClaimExecutionItemInput,
): Promise<ClaimExecutionItemResult> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const planItemId =
    typeof input.currentMetadata?.plan_item_id === "string"
      ? (input.currentMetadata.plan_item_id as string)
      : null;
  const claim: SchedulerClaimMetadata = {
    claimed_at: nowIso,
    claim_source: input.claimSource ?? "cron_tick",
    scheduler_run_id: input.schedulerRunId,
    plan_item_id: planItemId,
    ...(input.payloadFingerprint !== undefined
      ? { payload_fingerprint: input.payloadFingerprint }
      : {}),
  };
  const metadata: Record<string, unknown> = {
    ...input.currentMetadata,
    scheduler_claim: claim,
  };

  // The atomic part is the status guard: only a row that is STILL
  // 'scheduled' can move to 'running'. The metadata merge is based on
  // the snapshot the tick read; if another writer claimed first, this
  // update affects zero rows and our snapshot never lands.
  const { data, error } = await input.supabase
    .from("execution_items")
    .update({ status: "running", metadata } as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.itemId)
    .eq("status", "scheduled")
    .select("id");

  if (error) {
    return { claimed: false, reason: "claim_error", detail: error.message };
  }
  if (!data || data.length === 0) {
    return { claimed: false, reason: "already_claimed_or_moved" };
  }
  return { claimed: true, metadata };
}

/**
 * How old a `running` claim must be before the operator is told about
 * it. The publish path's worst-case network budget is well under this;
 * a claim older than 15 minutes means the function died mid-publish.
 * Recovery is deliberately MANUAL: the provider call may have
 * succeeded, so auto-rescheduling would reintroduce the double-publish
 * risk this module exists to remove.
 */
export const STALE_CLAIM_MINUTES = 15;

export function isStaleClaim(
  claimedAtIso: string | null | undefined,
  now: Date,
  staleMinutes: number = STALE_CLAIM_MINUTES,
): boolean {
  if (!claimedAtIso) return true; // running with no claim record = legacy/unknown → surface it
  const t = new Date(claimedAtIso).getTime();
  if (Number.isNaN(t)) return true;
  return now.getTime() - t >= staleMinutes * 60_000;
}
