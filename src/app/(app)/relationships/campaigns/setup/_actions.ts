"use server";
/**
 * Setting up automatic following, as one operation.
 *
 * The operator experiences a single flow — pick a list, pick a daily
 * number, confirm — but the lifecycle underneath is unchanged and
 * deliberately three steps:
 *
 *     create draft  →  durably build the queue  →  explicit activation
 *
 * Collapsing them would mean activating a campaign whose queue was
 * still being written, which is how a campaign ends up following the
 * first 10,000 profiles of a list and silently stopping.
 *
 * NOTHING HERE TOUCHES THE PROVIDER. Creating a draft, counting a
 * source and building a queue are all database work. The first request
 * to Bluesky happens when the cron dispatcher runs, after activation.
 */

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { getAccountById } from "@/repositories/account-repository";
import { recordActivity } from "@/repositories/activity-repository";
import { can } from "@/core/teams/permissions";
import type { WorkspaceRole } from "@/lib/supabase/types";
import { actionFail, actionOk, type ActionResult } from "@/lib/forms/action-result";
import {
  createCampaign,
  getCampaign,
  countMembersByStatus,
  updateCampaign,
} from "@/repositories/bluesky-campaign-repository";
import {
  getImportJob,
  countEligibleCandidates,
} from "@/repositories/bluesky-campaign-import-repository";
import { resumeCampaignImport } from "@/core/bluesky-campaigns/resume-import.server";
import { isDailyQuota } from "@/core/bluesky-campaigns/quota";
import {
  computeNextRunAt,
  isValidTimezone,
  parseMinutes,
} from "@/core/bluesky-campaigns/campaign-day";

const SETUP_PATH = "/relationships/campaigns/setup";
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

  // The same permission that gates connecting an account and manual
  // Follow/Unfollow. A campaign acts publicly from the operator's
  // account without supervision — if anything it deserves more.
  if (!can(membership.role, "connect_platforms")) {
    return {
      kind: "error",
      message:
        "Your role cannot set up automatic following. Ask an owner or admin.",
    };
  }
  return {
    kind: "ok",
    workspaceId: membership.workspace.id,
    userId: user.id,
    role: membership.role,
  };
}

// =====================================================================
// Step 1 — what the chosen source actually contains
// =====================================================================

export type SourcePreviewResult = ActionResult<{
  eligible: number;
  protectedExcluded: number;
}>;

/**
 * Count a source without reading it.
 *
 * The operator is told an exact number before committing, and that
 * number has to be right for a 100,000-row list — so it is a database
 * count, never the length of something fetched.
 */
export async function previewSourceAction(
  _prev: SourcePreviewResult,
  formData: FormData,
): Promise<SourcePreviewResult> {
  const ctx = await requireCtx();
  if (ctx.kind !== "ok") return actionFail(ctx.message);

  const operatorAccountId = String(formData.get("operator_account_id") ?? "");
  const targetProfileId = String(formData.get("target_profile_id") ?? "") || null;
  if (!operatorAccountId) return actionFail("Choose which account will follow.");

  try {
    const counts = await countEligibleCandidates({
      workspaceId: ctx.workspaceId,
      operatorAccountId,
      targetProfileId,
    });
    return actionOk(counts);
  } catch (err) {
    return actionFail(
      err instanceof Error ? err.message : "Could not count that list.",
    );
  }
}

// =====================================================================
// Step 2 — create the draft and start building its queue
// =====================================================================

export type StartSetupResult = ActionResult<{
  campaignId: string;
  imported: number;
  duplicates: number;
  excluded: number;
  complete: boolean;
  status: "running" | "ready" | "failed";
}>;

export async function startCampaignSetupAction(
  _prev: StartSetupResult,
  formData: FormData,
): Promise<StartSetupResult> {
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
  const sourceKind =
    String(formData.get("source_kind") ?? "candidates") === "target_followers"
      ? ("target_followers" as const)
      : ("candidates" as const);
  const targetProfileId = String(formData.get("target_profile_id") ?? "") || null;

  if (!name) return actionFail("Give this campaign a name you'll recognise.");
  if (name.length > 120) return actionFail("That name is too long (120 max).");
  // Validated against the closed set rather than merely bounded: an
  // arbitrary number would bypass the deliberate choice of options, and
  // the database CHECK would reject it anyway.
  if (!isDailyQuota(quotaRaw)) {
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
  if (sourceKind === "target_followers" && !targetProfileId) {
    return actionFail("Choose which profile's followers to use.");
  }

  let identity;
  try {
    identity = await getAccountById(ctx.workspaceId, operatorAccountId);
  } catch {
    return actionFail("That account is not in your workspace.");
  }
  if (identity.platform !== "bluesky") {
    return actionFail("Automatic following is Bluesky-only.");
  }

  try {
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
    });

    // Begin building the queue. One bounded unit of work; the rest
    // continues on later calls from the same durable checkpoint.
    const imported = await resumeCampaignImport({
      workspaceId: ctx.workspaceId,
      operatorAccountId,
      campaignId: campaign.id,
      sourceKind,
      targetProfileId,
    });

    await recordActivity({
      workspaceId: ctx.workspaceId,
      eventType: "bluesky_campaign.created",
      entityType: "bluesky_follow_campaign",
      entityId: campaign.id,
      title: `Follow campaign created: ${name}`,
      description: `${quotaRaw}/day, ${timezone}. Draft — not yet started.`,
    }).catch(() => undefined);

    revalidatePath(SETUP_PATH);
    revalidatePath(CAMPAIGNS_PATH);
    return actionOk({
      campaignId: campaign.id,
      imported: imported.totalImported,
      duplicates: imported.totalDuplicates,
      excluded: imported.totalExcluded,
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

export type ContinueImportResult = ActionResult<{
  imported: number;
  duplicates: number;
  excluded: number;
  complete: boolean;
  status: "running" | "ready" | "failed";
  summary: string;
}>;

/**
 * Resume the queue build.
 *
 * Takes only the campaign id. Where to continue from is the database's
 * business — the old flow asked the browser for a page number, which it
 * never sent, so every call restarted at the beginning and a list past
 * ~10,000 could never finish.
 */
export async function continueImportAction(
  _prev: ContinueImportResult,
  formData: FormData,
): Promise<ContinueImportResult> {
  const ctx = await requireCtx();
  if (ctx.kind !== "ok") return actionFail(ctx.message);

  const campaignId = String(formData.get("campaign_id") ?? "");
  const campaign = await getCampaign(ctx.workspaceId, campaignId);
  if (!campaign) return actionFail("That campaign is not in your workspace.");
  if (campaign.status === "cancelled" || campaign.status === "completed") {
    return actionFail(
      `This campaign is ${campaign.status}; its list can no longer be changed.`,
    );
  }

  const job = await getImportJob({
    workspaceId: ctx.workspaceId,
    campaignId,
  });
  if (!job) return actionFail("This campaign has no list to build yet.");

  try {
    const result = await resumeCampaignImport({
      workspaceId: ctx.workspaceId,
      operatorAccountId: campaign.operator_account_id,
      campaignId,
      sourceKind: job.sourceKind,
      targetProfileId: job.targetProfileId,
    });
    if (result.status === "failed" && result.error) {
      return actionFail(result.error);
    }
    revalidatePath(SETUP_PATH);
    revalidatePath(CAMPAIGNS_PATH);
    return actionOk({
      imported: result.totalImported,
      duplicates: result.totalDuplicates,
      excluded: result.totalExcluded,
      complete: result.complete,
      status: result.status,
      summary: result.complete
        ? `Ready: ${result.totalImported.toLocaleString()} profiles queued.`
        : `${result.totalImported.toLocaleString()} queued so far. Still adding — this can continue while you do other things.`,
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

export type ActivateSetupResult = ActionResult<{ summary: string }>;

export async function activateFromSetupAction(
  _prev: ActivateSetupResult,
  formData: FormData,
): Promise<ActivateSetupResult> {
  const ctx = await requireCtx();
  if (ctx.kind !== "ok") return actionFail(ctx.message);

  const campaignId = String(formData.get("campaign_id") ?? "");
  // A typed confirmation, so a stray Enter on a focused button cannot
  // start public activity from the operator's account.
  if (String(formData.get("confirm") ?? "") !== "start") {
    return actionFail("Confirm before starting.");
  }

  const campaign = await getCampaign(ctx.workspaceId, campaignId);
  if (!campaign) return actionFail("That campaign is not in your workspace.");
  if (campaign.status !== "draft" && campaign.status !== "paused") {
    return actionFail(`This campaign is ${campaign.status} and cannot be started here.`);
  }

  // THE QUEUE MUST BE FINISHED.
  //
  // A campaign activated mid-import follows whatever happened to be
  // written so far and reports itself complete when it runs out — the
  // operator would see "done" for a list that was never fully queued.
  const job = await getImportJob({ workspaceId: ctx.workspaceId, campaignId });
  if (!job) {
    return actionFail("Build the list of profiles before starting.");
  }
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
    return actionFail("There are no profiles in this list to follow.");
  }

  // The account must still be connected, or the first run would fail
  // on its very first request. Checked here rather than discovered by
  // the dispatcher at 09:00 tomorrow.
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
    expectedStatuses: ["draft", "paused"],
  });
  if (!updated) {
    return actionFail("The campaign changed while you were confirming. Reload and try again.");
  }

  await recordActivity({
    workspaceId: ctx.workspaceId,
    eventType: "bluesky_campaign.activated",
    entityType: "bluesky_follow_campaign",
    entityId: campaignId,
    title: `Follow campaign started: ${campaign.name}`,
    description: `Up to ${campaign.requested_daily_quota}/day requested across ${counts.total.toLocaleString()} profiles.`,
  }).catch(() => undefined);

  revalidatePath(SETUP_PATH);
  revalidatePath(CAMPAIGNS_PATH);
  revalidatePath("/relationships");
  return actionOk({
    summary: `Started. Signal will follow up to ${campaign.requested_daily_quota.toLocaleString()} profiles a day until all ${counts.total.toLocaleString()} are done.`,
  });
}
