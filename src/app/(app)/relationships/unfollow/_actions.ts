"use server";
/**
 * Setting up automatic unfollowing.
 *
 * The operator experiences one flow — pick a source, pick a daily
 * number, confirm once — but the lifecycle underneath is deliberately
 * three steps, exactly as the follow flow is:
 *
 *     draft → building_queue → ready → (one explicit activation) → active
 *
 * Collapsing them would mean activating a campaign whose queue was
 * still being written, and a campaign that runs out of a half-built
 * queue reports itself COMPLETE. The operator would see "done" for a
 * list that was never fully assembled — for an irreversible, publicly
 * visible action.
 *
 * NOTHING IN THIS FILE TOUCHES THE PROVIDER WITH A MUTATION. Creating a
 * draft, counting a source and building a queue are reads and database
 * writes. The first `deleteRecord` happens when the cron dispatcher
 * runs, after activation, and never before.
 */

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { getAccountById } from "@/repositories/account-repository";
import { resolveRelationshipSession } from "@/core/bluesky-relationships/session.server";
import { recordActivity } from "@/repositories/activity-repository";
import { can } from "@/core/teams/permissions";
import type { WorkspaceRole } from "@/lib/supabase/types";
import { actionFail, actionOk, type ActionResult } from "@/lib/forms/action-result";
import {
  createCampaign,
  countMembersByStatus,
  getCampaign,
  updateCampaign,
} from "@/repositories/bluesky-campaign-repository";
import {
  addToAllowlist,
  cancelFutureWork,
  countSource,
  removeFromAllowlist,
  type UnfollowSourceKind,
} from "@/repositories/bluesky-unfollow-repository";
import { resumeUnfollowImport } from "@/core/bluesky-unfollow/import.server";
import { isUnfollowDailyQuota } from "@/core/bluesky-unfollow/quota";
import {
  computeNextRunAt,
  isValidTimezone,
  parseMinutes,
} from "@/core/bluesky-campaigns/campaign-day";
import { requireCampaignServiceDb } from "@/core/bluesky-campaigns/service-db.server";
import { getImportJob } from "@/repositories/bluesky-campaign-import-repository";

const SETUP_PATH = "/relationships/unfollow";
const CAMPAIGNS_PATH = "/relationships/campaigns";

interface Ctx {
  kind: "ok";
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}
type CtxResult = Ctx | { kind: "error"; message: string };

async function requireCtx(): Promise<CtxResult> {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { kind: "error", message: "Sign in first." };

  const membership = await getPrimaryWorkspace();
  if (!membership) return { kind: "error", message: "No workspace found." };

  // The SAME permission that gates connecting an account, manual
  // follow/unfollow and automatic following. A campaign acts publicly
  // from the operator's account without supervision, and this one
  // removes relationships — if anything it deserves more than the
  // others, never less.
  if (!can(membership.role, "connect_platforms")) {
    return {
      kind: "error",
      message:
        "Your role cannot set up automatic unfollowing. Ask an owner or admin.",
    };
  }
  return {
    kind: "ok",
    workspaceId: membership.workspace.id,
    userId: user.id,
    role: membership.role,
  };
}

const SOURCE_KINDS: UnfollowSourceKind[] = [
  "following_records",
  "target_followers",
  "follow_campaign",
  "filtered_candidates",
];

function parseSource(value: string): UnfollowSourceKind | null {
  return SOURCE_KINDS.includes(value as UnfollowSourceKind)
    ? (value as UnfollowSourceKind)
    : null;
}

// =====================================================================
// Step 1 — what the chosen source actually contains
// =====================================================================

export type SourcePreviewResult = ActionResult<{
  eligible: number;
  protectedExcluded: number;
  /** True when the count cannot be known without walking the provider. */
  stillCounting: boolean;
}>;

/**
 * Count a source WITHOUT reading it.
 *
 * The operator is shown an exact number before committing, and that
 * number has to be right for a 100,000-row list — so it is a database
 * count, never the length of something fetched into memory.
 *
 * `following_records` is the honest exception. The acting repository
 * can only be counted by walking it at the provider, which is what the
 * queue build itself does, so this returns `stillCounting` rather than
 * inventing a figure. A confirmation screen that shows a made-up number
 * is worse than one that says it does not know yet.
 */
export async function previewUnfollowSourceAction(
  _prev: SourcePreviewResult,
  formData: FormData,
): Promise<SourcePreviewResult> {
  const ctx = await requireCtx();
  if (ctx.kind !== "ok") return actionFail(ctx.message);

  const operatorAccountId = String(formData.get("operator_account_id") ?? "");
  const sourceKind = parseSource(String(formData.get("source_kind") ?? ""));
  const targetProfileId = String(formData.get("target_profile_id") ?? "") || null;
  const sourceCampaignId = String(formData.get("source_campaign_id") ?? "") || null;

  if (!operatorAccountId) {
    return actionFail("Choose which account will unfollow.");
  }
  if (!sourceKind) return actionFail("Choose who to unfollow.");
  if (sourceKind === "target_followers" && !targetProfileId) {
    return actionFail("Choose which imported list to use.");
  }
  if (sourceKind === "follow_campaign" && !sourceCampaignId) {
    return actionFail("Choose which follow campaign to undo.");
  }

  if (sourceKind === "following_records") {
    return actionOk({
      eligible: 0,
      protectedExcluded: 0,
      stillCounting: true,
    });
  }

  try {
    const session = await resolveRelationshipSession({
      workspaceId: ctx.workspaceId,
      accountId: operatorAccountId,
    });
    if (!session.ok) return actionFail(session.message);

    const db = requireCampaignServiceDb();
    const counts = await countSource({
      workspaceId: ctx.workspaceId,
      operatorAccountId,
      actorDid: session.actorDid,
      sourceKind,
      targetProfileId,
      sourceCampaignId,
      db,
    });
    return actionOk({ ...counts, stillCounting: false });
  } catch (err) {
    return actionFail(
      err instanceof Error ? err.message : "Could not count that list.",
    );
  }
}

// =====================================================================
// Step 2 — create the draft and start building its queue
// =====================================================================

export type StartUnfollowSetupResult = ActionResult<{
  campaignId: string;
  imported: number;
  duplicates: number;
  protectedExcluded: number;
  complete: boolean;
  status: "running" | "ready" | "failed";
}>;

export async function startUnfollowSetupAction(
  _prev: StartUnfollowSetupResult,
  formData: FormData,
): Promise<StartUnfollowSetupResult> {
  const ctx = await requireCtx();
  if (ctx.kind !== "ok") return actionFail(ctx.message);

  const name = String(formData.get("name") ?? "").trim();
  const operatorAccountId = String(formData.get("operator_account_id") ?? "");
  const quotaRaw = Number(formData.get("requested_daily_quota"));
  const timezone = String(formData.get("timezone") ?? "UTC").trim();
  const windowStart = parseMinutes(String(formData.get("window_start") ?? "09:00"));
  const windowEnd = parseMinutes(String(formData.get("window_end") ?? "20:00"));
  const startDate = String(formData.get("start_date") ?? "").trim() || null;
  const dryRun = String(formData.get("dry_run") ?? "") === "1";
  const sourceKind = parseSource(String(formData.get("source_kind") ?? ""));
  const targetProfileId = String(formData.get("target_profile_id") ?? "") || null;
  const sourceCampaignId = String(formData.get("source_campaign_id") ?? "") || null;

  if (!name) return actionFail("Give this campaign a name you'll recognise.");
  if (name.length > 120) return actionFail("That name is too long (120 max).");
  // Validated against the closed set rather than merely bounded: an
  // arbitrary number would bypass the deliberate choice of options, and
  // the database CHECK would reject it anyway.
  if (!isUnfollowDailyQuota(quotaRaw)) {
    return actionFail("Choose one of the offered daily amounts.");
  }
  if (!isValidTimezone(timezone)) {
    return actionFail("That time zone is not one this server recognises.");
  }
  if (windowStart === null || windowEnd === null) {
    return actionFail("Enter the daily time range as HH:MM.");
  }
  if (windowEnd <= windowStart) {
    return actionFail("The end time must be after the start time.");
  }
  if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    return actionFail("Enter the start date as YYYY-MM-DD.");
  }
  if (!sourceKind) return actionFail("Choose who to unfollow.");
  if (sourceKind === "target_followers" && !targetProfileId) {
    return actionFail("Choose which imported list to use.");
  }
  if (sourceKind === "follow_campaign" && !sourceCampaignId) {
    return actionFail("Choose which follow campaign to undo.");
  }

  let identity;
  try {
    identity = await getAccountById(ctx.workspaceId, operatorAccountId);
  } catch {
    return actionFail("That account is not in your workspace.");
  }
  if (identity.platform !== "bluesky") {
    return actionFail("Automatic unfollowing is Bluesky-only.");
  }

  try {
    const db = requireCampaignServiceDb();
    // DRAFT. Nothing runs until the operator confirms at the last step.
    const campaign = await createCampaign({
      workspaceId: ctx.workspaceId,
      operatorAccountId,
      name,
      requestedDailyQuota: quotaRaw,
      timezone,
      windowStartMinute: windowStart,
      windowEndMinute: windowEnd,
      startDate,
      dryRun,
      createdBy: ctx.userId,
      kind: "unfollow",
    });

    const imported = await resumeUnfollowImport({
      workspaceId: ctx.workspaceId,
      campaignId: campaign.id,
      operatorAccountId,
      sourceKind,
      targetProfileId,
      sourceCampaignId,
      db,
    });

    await recordActivity({
      workspaceId: ctx.workspaceId,
      eventType: "bluesky_unfollow_campaign.created",
      entityType: "bluesky_follow_campaign",
      entityId: campaign.id,
      title: `Unfollow campaign created: ${name}`,
      description: `${quotaRaw}/day, ${timezone}. Draft — not yet started.`,
    }).catch(() => undefined);

    revalidatePath(SETUP_PATH);
    revalidatePath(CAMPAIGNS_PATH);
    return actionOk({
      campaignId: campaign.id,
      imported: imported.totalImported,
      duplicates: imported.totalDuplicates,
      protectedExcluded: imported.totalProtected,
      complete: imported.complete,
      status: imported.status,
    });
  } catch (err) {
    return actionFail(
      err instanceof Error ? err.message : "Could not set up the campaign.",
    );
  }
}

// =====================================================================
// Continue building — as many times as it takes
// =====================================================================

export type ContinueUnfollowImportResult = ActionResult<{
  imported: number;
  duplicates: number;
  protectedExcluded: number;
  complete: boolean;
  status: "running" | "ready" | "failed";
  summary: string;
}>;

/**
 * Resume the queue build.
 *
 * Takes only the campaign id. WHERE to continue from is the database's
 * business — a browser asked for a page number is a browser that can
 * close, reload, or send the wrong one, and a list past ~10,000 could
 * then never finish.
 */
export async function continueUnfollowImportAction(
  _prev: ContinueUnfollowImportResult,
  formData: FormData,
): Promise<ContinueUnfollowImportResult> {
  const ctx = await requireCtx();
  if (ctx.kind !== "ok") return actionFail(ctx.message);

  const campaignId = String(formData.get("campaign_id") ?? "");
  const campaign = await getCampaign(ctx.workspaceId, campaignId);
  if (!campaign) return actionFail("That campaign is not in your workspace.");

  try {
    const db = requireCampaignServiceDb();
    const job = await getImportJob({
      workspaceId: ctx.workspaceId,
      campaignId,
      db,
    });
    if (!job) return actionFail("This campaign has no list to build yet.");

    const raw = job as unknown as {
      sourceKind: string;
      targetProfileId: string | null;
      sourceCampaignId?: string | null;
    };
    const sourceKind = parseSource(raw.sourceKind);
    if (!sourceKind) {
      return actionFail("This campaign's list source is not an unfollow source.");
    }

    const result = await resumeUnfollowImport({
      workspaceId: ctx.workspaceId,
      campaignId,
      operatorAccountId: campaign.operator_account_id,
      sourceKind,
      targetProfileId: raw.targetProfileId,
      sourceCampaignId: raw.sourceCampaignId ?? null,
      db,
    });
    if (result.status === "failed" && result.error) return actionFail(result.error);

    revalidatePath(SETUP_PATH);
    revalidatePath(CAMPAIGNS_PATH);
    return actionOk({
      imported: result.totalImported,
      duplicates: result.totalDuplicates,
      protectedExcluded: result.totalProtected,
      complete: result.complete,
      status: result.status,
      summary: result.complete
        ? `Ready: ${result.totalImported.toLocaleString()} profiles queued.`
        : `${result.totalImported.toLocaleString()} queued so far. Still building — you can leave this page; it continues where it left off.`,
    });
  } catch (err) {
    return actionFail(
      err instanceof Error ? err.message : "The list could not be built.",
    );
  }
}

// =====================================================================
// Step 3 — start it, once, explicitly
// =====================================================================

export type ActivateUnfollowResult = ActionResult<{ summary: string }>;

export async function activateUnfollowCampaignAction(
  _prev: ActivateUnfollowResult,
  formData: FormData,
): Promise<ActivateUnfollowResult> {
  const ctx = await requireCtx();
  if (ctx.kind !== "ok") return actionFail(ctx.message);

  const campaignId = String(formData.get("campaign_id") ?? "");

  // A TYPED confirmation, so a stray Enter on a focused button cannot
  // start irreversible public activity from the operator's account.
  if (String(formData.get("confirm") ?? "") !== "start automatic unfollowing") {
    return actionFail("Type the confirmation exactly, then start.");
  }

  const campaign = await getCampaign(ctx.workspaceId, campaignId);
  if (!campaign) return actionFail("That campaign is not in your workspace.");

  if (campaign.kind !== "unfollow") {
    return actionFail("That campaign is not an unfollow campaign.");
  }
  if (campaign.status !== "ready" && campaign.status !== "paused") {
    return actionFail(
      campaign.status === "building_queue" || campaign.status === "draft"
        ? "The list is still being built. Wait until it says ready, then start."
        : `This campaign is ${campaign.status} and cannot be started here.`,
    );
  }

  // The OPERATOR must confirm the exact identity they are acting as.
  // Not a checkbox: the handle they typed is compared to the one the
  // session actually resolves to, so a campaign cannot be started
  // against an account they did not mean.
  const confirmedIdentity = String(formData.get("confirm_identity") ?? "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
  if (!confirmedIdentity) {
    return actionFail("Type the Bluesky handle this will act as.");
  }

  let db;
  try {
    db = requireCampaignServiceDb();
  } catch (err) {
    return actionFail(
      err instanceof Error ? err.message : "Campaign worker unavailable.",
    );
  }

  // THE QUEUE MUST BE FINISHED.
  //
  // A campaign activated mid-import unfollows whatever happened to be
  // written so far and reports itself complete when it runs out. The
  // operator would see "done" for a list that was never fully queued —
  // and for deletions, "we stopped early" is indistinguishable from
  // "we finished" without this check.
  const job = await getImportJob({ workspaceId: ctx.workspaceId, campaignId, db });
  if (!job) return actionFail("Build the list of profiles before starting.");
  if (job.status === "failed") {
    return actionFail(
      job.lastError
        ? `The list could not be finished: ${job.lastError}`
        : "The list could not be finished. Try building it again.",
    );
  }
  if (!job.sourceExhausted) {
    return actionFail(
      "The list is still being built. Wait until it says ready, then start.",
    );
  }

  const counts = await countMembersByStatus({
    workspaceId: ctx.workspaceId,
    campaignId,
  });
  if (counts.total === 0) {
    return actionFail("There are no profiles in this list to unfollow.");
  }

  // The account must still be connected, and the session must actually
  // WORK — the status column says what we last wrote, not whether
  // Bluesky still accepts it.
  try {
    const identity = await getAccountById(
      ctx.workspaceId,
      campaign.operator_account_id,
    );
    if (identity.connectionStatus !== "connected") {
      return actionFail(
        "That Bluesky account is not signed in. Reconnect it on Accounts, then start.",
      );
    }
    const session = await resolveRelationshipSession({
      workspaceId: ctx.workspaceId,
      accountId: campaign.operator_account_id,
    });
    if (!session.ok) {
      return actionFail(
        `${session.message} Reconnect the account on Accounts, then start.`,
      );
    }
    const actual = (session.actorHandle ?? "").trim().toLowerCase();
    if (!actual || actual !== confirmedIdentity) {
      return actionFail(
        `This would act as @${actual || "an unknown account"}, which is not the handle you typed. Nothing was started.`,
      );
    }
  } catch {
    return actionFail("That account is no longer in this workspace.");
  }

  const nextRunAt = computeNextRunAt({
    from: new Date(),
    timezone: campaign.timezone,
    window: {
      startMinute: campaign.execution_window_start_minute,
      endMinute: campaign.execution_window_end_minute,
    },
    notBeforeLocalDate: campaign.start_date,
  });

  const updated = await updateCampaign({
    workspaceId: ctx.workspaceId,
    campaignId,
    status: "active",
    activatedAt: campaign.activated_at ?? new Date().toISOString(),
    pausedAt: null,
    nextRunAt: nextRunAt.toISOString(),
    lastErrorCode: null,
    lastErrorMessage: null,
    // Compare-and-set: if something moved it since we read it, do
    // nothing rather than overwriting that transition.
    expectedStatuses: ["ready", "paused"],
  });
  if (!updated) {
    return actionFail(
      "The campaign changed while you were confirming. Reload and try again.",
    );
  }

  await recordActivity({
    workspaceId: ctx.workspaceId,
    eventType: "bluesky_unfollow_campaign.activated",
    entityType: "bluesky_follow_campaign",
    entityId: campaignId,
    title: `Unfollow campaign started: ${campaign.name}`,
    description: `Up to ${campaign.requested_daily_quota}/day across ${counts.total.toLocaleString()} profiles.`,
  }).catch(() => undefined);

  revalidatePath(SETUP_PATH);
  revalidatePath(CAMPAIGNS_PATH);
  revalidatePath("/relationships");
  return actionOk({
    summary: campaign.dry_run
      ? `Started as a DRY RUN. Signal will go through the motions for up to ${campaign.requested_daily_quota.toLocaleString()} profiles a day and send nothing to Bluesky.`
      : `Started. Signal will unfollow up to ${campaign.requested_daily_quota.toLocaleString()} profiles a day until all ${counts.total.toLocaleString()} are done.`,
  });
}

// =====================================================================
// Running control
// =====================================================================

export type ControlResult = ActionResult<{ summary: string }>;

export async function pauseUnfollowCampaignAction(
  _prev: ControlResult,
  formData: FormData,
): Promise<ControlResult> {
  const ctx = await requireCtx();
  if (ctx.kind !== "ok") return actionFail(ctx.message);
  const campaignId = String(formData.get("campaign_id") ?? "");

  const updated = await updateCampaign({
    workspaceId: ctx.workspaceId,
    campaignId,
    status: "paused",
    pausedAt: new Date().toISOString(),
    nextRunAt: null,
    expectedStatuses: ["active", "rate_limited", "reauthorization_required"],
  });
  if (!updated) return actionFail("That campaign is not currently running.");

  revalidatePath(CAMPAIGNS_PATH);
  revalidatePath("/relationships");
  return actionOk({
    summary:
      "Paused. Nothing further will be sent. Profiles already unfollowed stay unfollowed — pausing does not re-follow anyone.",
  });
}

export async function resumeUnfollowCampaignAction(
  _prev: ControlResult,
  formData: FormData,
): Promise<ControlResult> {
  const ctx = await requireCtx();
  if (ctx.kind !== "ok") return actionFail(ctx.message);
  const campaignId = String(formData.get("campaign_id") ?? "");

  const campaign = await getCampaign(ctx.workspaceId, campaignId);
  if (!campaign) return actionFail("That campaign is not in your workspace.");

  // Resuming re-checks the session, for the same reason activation
  // does: the status column records what we last wrote, not whether
  // Bluesky still accepts it.
  const session = await resolveRelationshipSession({
    workspaceId: ctx.workspaceId,
    accountId: campaign.operator_account_id,
  });
  if (!session.ok) {
    return actionFail(`${session.message} Reconnect the account, then resume.`);
  }

  const updated = await updateCampaign({
    workspaceId: ctx.workspaceId,
    campaignId,
    status: "active",
    pausedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    nextRunAt: computeNextRunAt({
      from: new Date(),
      timezone: campaign.timezone,
      window: {
        startMinute: campaign.execution_window_start_minute,
        endMinute: campaign.execution_window_end_minute,
      },
    }).toISOString(),
    expectedStatuses: ["paused", "reauthorization_required"],
  });
  if (!updated) return actionFail("That campaign is not paused.");

  revalidatePath(CAMPAIGNS_PATH);
  revalidatePath("/relationships");
  return actionOk({ summary: "Resumed. It continues on its usual schedule." });
}

export async function cancelUnfollowCampaignAction(
  _prev: ControlResult,
  formData: FormData,
): Promise<ControlResult> {
  const ctx = await requireCtx();
  if (ctx.kind !== "ok") return actionFail(ctx.message);
  const campaignId = String(formData.get("campaign_id") ?? "");
  if (String(formData.get("confirm") ?? "") !== "cancel") {
    return actionFail("Confirm before cancelling.");
  }

  try {
    const db = requireCampaignServiceDb();
    const result = await cancelFutureWork({
      workspaceId: ctx.workspaceId,
      campaignId,
      db,
    });
    revalidatePath(CAMPAIGNS_PATH);
    revalidatePath("/relationships");
    return actionOk({
      summary:
        `Cancelled. ${result.cancelledMembers.toLocaleString()} profiles will not be touched.` +
        (result.leftUnresolved > 0
          ? ` ${result.leftUnresolved.toLocaleString()} are still being checked against Bluesky and are left alone rather than marked cancelled — their outcome is not yet known.`
          : "") +
        " Profiles already unfollowed stay unfollowed: cancelling stops future work and does not re-follow anyone.",
    });
  } catch (err) {
    return actionFail(
      err instanceof Error ? err.message : "Could not cancel the campaign.",
    );
  }
}

/**
 * Stop this identity — BOTH kinds.
 *
 * The switch is keyed on the identity and is consulted by the follow
 * dispatcher and the unfollow dispatcher alike, before either makes any
 * provider call. "Stop this account" that stopped only half of what the
 * account was doing would be a lie told at the worst moment.
 */
export async function stopIdentityAction(
  _prev: ControlResult,
  formData: FormData,
): Promise<ControlResult> {
  const ctx = await requireCtx();
  if (ctx.kind !== "ok") return actionFail(ctx.message);
  const operatorAccountId = String(formData.get("operator_account_id") ?? "");
  if (!operatorAccountId) return actionFail("Choose an account to stop.");

  const supabase = createSupabaseServerClient();
  const { error } = await supabase
    .from("bluesky_campaign_kill_switches")
    .upsert(
      {
        workspace_id: ctx.workspaceId,
        operator_account_id: operatorAccountId,
        engaged: true,
        reason: String(formData.get("reason") ?? "Stopped by the operator."),
        engaged_by: ctx.userId,
        engaged_at: new Date().toISOString(),
        released_at: null,
      },
      { onConflict: "workspace_id,operator_account_id" },
    );
  if (error) return actionFail("Could not stop this account.");

  revalidatePath(CAMPAIGNS_PATH);
  revalidatePath("/relationships");
  return actionOk({
    summary:
      "Stopped. No follow or unfollow campaign will act as this account until you release it.",
  });
}

// =====================================================================
// The "never unfollow" allowlist
// =====================================================================

export async function addAllowlistEntryAction(
  _prev: ControlResult,
  formData: FormData,
): Promise<ControlResult> {
  const ctx = await requireCtx();
  if (ctx.kind !== "ok") return actionFail(ctx.message);

  const subjectDid = String(formData.get("subject_did") ?? "").trim();
  if (!subjectDid.startsWith("did:")) {
    return actionFail("That is not a Bluesky account identifier.");
  }
  const operatorAccountId =
    String(formData.get("operator_account_id") ?? "").trim() || null;

  try {
    await addToAllowlist({
      workspaceId: ctx.workspaceId,
      operatorAccountId,
      subjectDid,
      subjectHandle: String(formData.get("subject_handle") ?? "").trim() || null,
      reason: String(formData.get("reason") ?? "").trim() || null,
      addedBy: ctx.userId,
    });
    revalidatePath(SETUP_PATH);
    return actionOk({
      summary:
        "Added. No unfollow campaign will touch this profile, including campaigns whose list was already built.",
    });
  } catch (err) {
    return actionFail(
      err instanceof Error ? err.message : "Could not add to the list.",
    );
  }
}

export async function removeAllowlistEntryAction(
  _prev: ControlResult,
  formData: FormData,
): Promise<ControlResult> {
  const ctx = await requireCtx();
  if (ctx.kind !== "ok") return actionFail(ctx.message);
  const entryId = String(formData.get("entry_id") ?? "");
  if (!entryId) return actionFail("Nothing to remove.");

  try {
    await removeFromAllowlist({ workspaceId: ctx.workspaceId, entryId });
    revalidatePath(SETUP_PATH);
    return actionOk({
      summary:
        "Removed. This profile is no longer protected from automatic unfollowing.",
    });
  } catch (err) {
    return actionFail(
      err instanceof Error ? err.message : "Could not remove the entry.",
    );
  }
}
