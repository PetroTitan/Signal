"use server";
/**
 * Server actions for Bluesky follow campaigns.
 *
 * THE AUTHORIZATION BOUNDARY.
 *
 * Every export runs `requireCampaignContext`, which establishes, in
 * order and refusing at the first failure: an authenticated user, a
 * workspace membership, the `connect_platforms` permission, and — for
 * anything naming an identity or a campaign — that the row actually
 * belongs to that workspace. A uuid in a form field is a claim, not
 * evidence, until it survives a workspace-scoped query.
 *
 * WHAT THE CLIENT IS NEVER TRUSTED WITH
 * -------------------------------------
 *   - the workspace id (taken from the session, never from the form);
 *   - the effective quota (computed by the server, per run);
 *   - which members to process (chosen by the claiming RPC);
 *   - any count (every count is an exact database query).
 *
 * The only things a form supplies are an intent and identifiers, and
 * every identifier is re-resolved against the caller's workspace.
 */

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { getAccountById } from "@/repositories/account-repository";
import { recordActivity } from "@/repositories/activity-repository";
import { can } from "@/core/teams/permissions";
import type { WorkspaceRole } from "@/lib/supabase/types";
import {
  actionFail,
  actionOk,
  type ActionResult,
} from "@/lib/forms/action-result";
import {
  createCampaign,
  getCampaign,
  setKillSwitch,
  updateCampaign,
} from "@/repositories/bluesky-campaign-repository";
import { importFromTargetFollowers } from "@/core/bluesky-campaigns/import-members.server";
import { resumeCampaignImport } from "@/core/bluesky-campaigns/resume-import.server";
import { isDailyQuota } from "@/core/bluesky-campaigns/quota";
import { getImportJob } from "@/repositories/bluesky-campaign-import-repository";
import {
  computeNextRunAt,
  isValidTimezone,
  parseMinutes,
} from "@/core/bluesky-campaigns/campaign-day";

const CAMPAIGNS_PATH = "/relationships/campaigns";

interface CampaignContext {
  kind: "ok";
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}

type ContextResult = CampaignContext | { kind: "error"; message: string };

async function requireCampaignContext(): Promise<ContextResult> {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { kind: "error", message: "Sign in first." };

  const membership = await getPrimaryWorkspace();
  if (!membership) return { kind: "error", message: "No workspace found." };

  // The same permission that gates connecting an account and the manual
  // Follow/Unfollow workflows. A campaign follows real people from the
  // operator's account in public, unattended — if anything it deserves
  // more, not less.
  if (!can(membership.role, "connect_platforms")) {
    return {
      kind: "error",
      message:
        "Your role cannot manage Bluesky follow campaigns. Ask an owner or admin.",
    };
  }

  return {
    kind: "ok",
    workspaceId: membership.workspace.id,
    userId: user.id,
    role: membership.role,
  };
}

/** Re-resolve a campaign inside the caller's workspace. */
async function requireCampaign(ctx: CampaignContext, campaignId: string) {
  if (!campaignId) return null;
  return getCampaign(ctx.workspaceId, campaignId);
}

// =====================================================================
// Create
// =====================================================================

export type CreateCampaignResult = ActionResult<{ campaignId: string }>;

export async function createCampaignAction(
  _prev: CreateCampaignResult,
  formData: FormData,
): Promise<CreateCampaignResult> {
  const ctx = await requireCampaignContext();
  if (ctx.kind !== "ok") return actionFail(ctx.message);

  const name = String(formData.get("name") ?? "").trim();
  const operatorAccountId = String(formData.get("operator_account_id") ?? "");
  const quotaRaw = Number(formData.get("requested_daily_quota"));
  const timezone = String(formData.get("timezone") ?? "UTC").trim();
  const windowStart = parseMinutes(String(formData.get("window_start") ?? "09:00"));
  const windowEnd = parseMinutes(String(formData.get("window_end") ?? "20:00"));
  const startDate = String(formData.get("start_date") ?? "").trim() || null;
  const dryRun = String(formData.get("dry_run") ?? "") === "1";

  if (!name) return actionFail("Give the campaign a name.");
  if (name.length > 120) return actionFail("That name is too long (120 max).");
  // The quota is validated against the closed set, not merely bounded:
  // an arbitrary number would bypass the deliberate choice of options.
  if (!isDailyQuota(quotaRaw)) {
    return actionFail("Pick a daily quota from the offered options.");
  }
  if (!isValidTimezone(timezone)) {
    return actionFail("That timezone is not one this server recognises.");
  }
  if (windowStart === null || windowEnd === null) {
    return actionFail("Enter the execution window as HH:MM.");
  }
  if (windowEnd <= windowStart) {
    return actionFail("The window must end after it starts.");
  }
  if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    return actionFail("Enter the start date as YYYY-MM-DD.");
  }

  // The identity must be a Bluesky identity in THIS workspace.
  let identity;
  try {
    identity = await getAccountById(ctx.workspaceId, operatorAccountId);
  } catch {
    return actionFail("That identity is not in your workspace.");
  }
  if (identity.platform !== "bluesky") {
    return actionFail("Follow campaigns are Bluesky-only.");
  }

  try {
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
    await recordActivity({
      workspaceId: ctx.workspaceId,
      eventType: "bluesky_campaign.created",
      entityType: "bluesky_follow_campaign",
      entityId: campaign.id,
      title: `Follow campaign created: ${name}`,
      description: `${quotaRaw}/day, ${timezone}. Draft — not yet activated.`,
    }).catch(() => undefined);

    revalidatePath(CAMPAIGNS_PATH);
    return actionOk({ campaignId: campaign.id });
  } catch (err) {
    return actionFail(
      err instanceof Error ? err.message : "Could not create the campaign.",
    );
  }
}

// =====================================================================
// Import members
// =====================================================================

export type ImportCampaignResult = ActionResult<{
  inserted: number;
  duplicates: number;
  complete: boolean;
  summary: string;
}>;

export async function importCampaignMembersAction(
  _prev: ImportCampaignResult,
  formData: FormData,
): Promise<ImportCampaignResult> {
  const ctx = await requireCampaignContext();
  if (ctx.kind !== "ok") return actionFail(ctx.message);

  const campaignId = String(formData.get("campaign_id") ?? "");
  const source = String(formData.get("source") ?? "candidates");
  const targetProfileId = String(formData.get("target_profile_id") ?? "");
  const cursor = String(formData.get("cursor") ?? "") || null;

  const campaign = await requireCampaign(ctx, campaignId);
  if (!campaign) return actionFail("That campaign is not in your workspace.");

  // Importing into a finished campaign would be a silent widening of
  // work that already concluded.
  if (campaign.status === "cancelled" || campaign.status === "completed") {
    return actionFail(
      `This campaign is ${campaign.status}; its queue can no longer be changed.`,
    );
  }

  try {
    if (source === "target") {
      if (!targetProfileId) return actionFail("Pick a target profile.");
      const result = await importFromTargetFollowers({
        workspaceId: ctx.workspaceId,
        campaignId,
        targetProfileId,
        cursor,
      });
      if (result.error) return actionFail(result.error);
      revalidatePath(CAMPAIGNS_PATH);
      return actionOk({
        inserted: result.inserted,
        duplicates: result.duplicates,
        complete: result.complete,
        summary: result.complete
          ? `Added ${result.inserted.toLocaleString()} profile(s). This target's follower list is fully imported.`
          : `Added ${result.inserted.toLocaleString()} profile(s) so far. More remain — run Continue import again.`,
      });
    }

    // Resumed from the DATABASE's checkpoint, never from a page number
    // supplied by the browser. The old call took `start_page` from the
    // form, the form never sent it, and so every invocation restarted
    // at page 1 — a list past ~10,000 could never finish.
    const result = await resumeCampaignImport({
      workspaceId: ctx.workspaceId,
      operatorAccountId: campaign.operator_account_id,
      campaignId,
      sourceKind: "candidates",
      targetProfileId: null,
    });
    if (result.error) return actionFail(result.error);
    revalidatePath(CAMPAIGNS_PATH);
    return actionOk({
      inserted: result.imported,
      duplicates: result.duplicates,
      complete: result.complete,
      summary: result.complete
        ? `Added ${result.totalImported.toLocaleString()} profile(s) from your candidate list (${result.totalDuplicates.toLocaleString()} already queued).`
        : `${result.totalImported.toLocaleString()} queued so far. More remain — run it again to continue.`,
    });
  } catch (err) {
    return actionFail(
      err instanceof Error ? err.message : "The import could not run.",
    );
  }
}

// =====================================================================
// Lifecycle
// =====================================================================

export type CampaignLifecycleResult = ActionResult<{
  status: string;
  summary: string;
}>;

/**
 * Activate.
 *
 * The one irreversible-in-spirit transition: after this the campaign
 * follows real people on its own schedule until it finishes or is
 * stopped. It therefore requires an explicit confirmation token from
 * the confirmation dialog — not because the token is a security
 * control (it is not; it comes from the client), but because it makes
 * an accidental activation from a stale form impossible.
 */
export async function activateCampaignAction(
  _prev: CampaignLifecycleResult,
  formData: FormData,
): Promise<CampaignLifecycleResult> {
  const ctx = await requireCampaignContext();
  if (ctx.kind !== "ok") return actionFail(ctx.message);

  const campaignId = String(formData.get("campaign_id") ?? "");
  const campaign = await requireCampaign(ctx, campaignId);
  if (!campaign) return actionFail("That campaign is not in your workspace.");

  if (campaign.status !== "draft" && campaign.status !== "paused") {
    return actionFail(
      `This campaign is ${campaign.status} and cannot be activated from here.`,
    );
  }

  // The identity must still be connected, or the campaign would
  // activate and immediately stop for reauthorization.
  try {
    const identity = await getAccountById(
      ctx.workspaceId,
      campaign.operator_account_id,
    );
    if (identity.connectionStatus !== "connected") {
      return actionFail(
        "That Bluesky identity is not signed in. Connect it on Accounts before activating.",
      );
    }
  } catch {
    return actionFail("The campaign's identity is no longer in this workspace.");
  }

  // THE QUEUE MUST BE FINISHED before anything starts.
  //
  // A campaign activated mid-import follows whatever happened to be
  // written so far and then reports itself complete — the operator sees
  // "done" for a list that was never fully queued. Campaigns created
  // before import jobs existed have no job row and are unaffected.
  const importJob = await getImportJob({
    workspaceId: ctx.workspaceId,
    campaignId,
  });
  if (importJob && importJob.status === "failed") {
    return actionFail(
      importJob.lastError
        ? `The list could not be finished: ${importJob.lastError}`
        : "The list could not be finished. Build it again before activating.",
    );
  }
  if (importJob && !importJob.sourceExhausted) {
    return actionFail(
      "The list of profiles is still being built. Wait until it is ready, then activate.",
    );
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
    title: `Follow campaign activated: ${campaign.name}`,
    description: `Up to ${campaign.requested_daily_quota}/day requested. First run at ${nextRunAt.toISOString()}.`,
  }).catch(() => undefined);

  revalidatePath(CAMPAIGNS_PATH);
  return actionOk({
    status: "active",
    summary: `Activated. The first run is scheduled for ${nextRunAt.toISOString()}.`,
  });
}

export async function pauseCampaignAction(
  _prev: CampaignLifecycleResult,
  formData: FormData,
): Promise<CampaignLifecycleResult> {
  const ctx = await requireCampaignContext();
  if (ctx.kind !== "ok") return actionFail(ctx.message);

  const campaignId = String(formData.get("campaign_id") ?? "");
  const campaign = await requireCampaign(ctx, campaignId);
  if (!campaign) return actionFail("That campaign is not in your workspace.");

  const updated = await updateCampaign({
    workspaceId: ctx.workspaceId,
    campaignId,
    status: "paused",
    pausedAt: new Date().toISOString(),
    nextRunAt: null,
    // Anything still running can be paused; a completed or cancelled
    // campaign cannot.
    expectedStatuses: ["active", "rate_limited", "reauthorization_required"],
  });
  if (!updated) {
    return actionFail(`This campaign is ${campaign.status} and cannot be paused.`);
  }

  await recordActivity({
    workspaceId: ctx.workspaceId,
    eventType: "bluesky_campaign.paused",
    entityType: "bluesky_follow_campaign",
    entityId: campaignId,
    title: `Follow campaign paused: ${campaign.name}`,
  }).catch(() => undefined);

  revalidatePath(CAMPAIGNS_PATH);
  return actionOk({
    status: "paused",
    // Queue position is not "saved" by anything special — it is simply
    // row state, and pausing changes none of it.
    summary:
      "Paused. No new profiles will be claimed. Your queue position and progress are unchanged.",
  });
}

export async function cancelCampaignAction(
  _prev: CampaignLifecycleResult,
  formData: FormData,
): Promise<CampaignLifecycleResult> {
  const ctx = await requireCampaignContext();
  if (ctx.kind !== "ok") return actionFail(ctx.message);

  const campaignId = String(formData.get("campaign_id") ?? "");
  const campaign = await requireCampaign(ctx, campaignId);
  if (!campaign) return actionFail("That campaign is not in your workspace.");

  const updated = await updateCampaign({
    workspaceId: ctx.workspaceId,
    campaignId,
    status: "cancelled",
    cancelledAt: new Date().toISOString(),
    nextRunAt: null,
    expectedStatuses: [
      "draft",
      "active",
      "paused",
      "rate_limited",
      "reauthorization_required",
      "failed",
    ],
  });
  if (!updated) {
    return actionFail(`This campaign is already ${campaign.status}.`);
  }

  await recordActivity({
    workspaceId: ctx.workspaceId,
    eventType: "bluesky_campaign.cancelled",
    entityType: "bluesky_follow_campaign",
    entityId: campaignId,
    title: `Follow campaign cancelled: ${campaign.name}`,
  }).catch(() => undefined);

  revalidatePath(CAMPAIGNS_PATH);
  return actionOk({
    status: "cancelled",
    summary:
      "Cancelled. No further follows will be attempted. Everything already followed stays followed — this does not unfollow anyone.",
  });
}

export type QuotaChangeResult = ActionResult<{ quota: number; summary: string }>;

/**
 * Change the requested daily quota.
 *
 * Affects FUTURE runs only. Today's run froze its requested and
 * effective quota when it was created, and nothing here touches it —
 * so a quota raised at noon does not retroactively widen work that was
 * already approved and counted for today.
 */
export async function changeQuotaAction(
  _prev: QuotaChangeResult,
  formData: FormData,
): Promise<QuotaChangeResult> {
  const ctx = await requireCampaignContext();
  if (ctx.kind !== "ok") return actionFail(ctx.message);

  const campaignId = String(formData.get("campaign_id") ?? "");
  const quota = Number(formData.get("requested_daily_quota"));
  if (!isDailyQuota(quota)) {
    return actionFail("Pick a daily quota from the offered options.");
  }

  const campaign = await requireCampaign(ctx, campaignId);
  if (!campaign) return actionFail("That campaign is not in your workspace.");
  if (campaign.status === "completed" || campaign.status === "cancelled") {
    return actionFail(`This campaign is ${campaign.status}.`);
  }

  await updateCampaign({
    workspaceId: ctx.workspaceId,
    campaignId,
    requestedDailyQuota: quota,
  });

  revalidatePath(CAMPAIGNS_PATH);
  return actionOk({
    quota,
    summary: `Future runs will request up to ${quota}/day. Today's run keeps the quota it started with.`,
  });
}

// =====================================================================
// Kill switches
// =====================================================================

export type KillSwitchResult = ActionResult<{ summary: string }>;

export async function setKillSwitchAction(
  _prev: KillSwitchResult,
  formData: FormData,
): Promise<KillSwitchResult> {
  const ctx = await requireCampaignContext();
  if (ctx.kind !== "ok") return actionFail(ctx.message);

  const scope = String(formData.get("scope") ?? "workspace");
  const engaged = String(formData.get("engaged") ?? "") === "1";
  const identityId = String(formData.get("operator_account_id") ?? "");
  const reason = String(formData.get("reason") ?? "").trim() || null;

  let operatorAccountId: string | null = null;
  if (scope === "identity") {
    if (!identityId) return actionFail("Pick an identity.");
    try {
      await getAccountById(ctx.workspaceId, identityId);
    } catch {
      return actionFail("That identity is not in your workspace.");
    }
    operatorAccountId = identityId;
  }

  try {
    await setKillSwitch({
      workspaceId: ctx.workspaceId,
      operatorAccountId,
      engaged,
      reason,
      engagedBy: ctx.userId,
    });
    await recordActivity({
      workspaceId: ctx.workspaceId,
      eventType: engaged
        ? "bluesky_campaign.kill_switch_engaged"
        : "bluesky_campaign.kill_switch_released",
      entityType: "bluesky_campaign_kill_switch",
      entityId: operatorAccountId ?? ctx.workspaceId,
      title: engaged
        ? `Campaign kill switch ENGAGED (${scope})`
        : `Campaign kill switch released (${scope})`,
      description: reason,
    }).catch(() => undefined);

    revalidatePath(CAMPAIGNS_PATH);
    return actionOk({
      summary: engaged
        ? scope === "identity"
          ? "Stopped. No campaign using this identity will run until the switch is released."
          : "Stopped. No campaign in this workspace will run until the switch is released."
        : "Released. Campaigns will resume on their next scheduled run.",
    });
  } catch (err) {
    return actionFail(
      err instanceof Error ? err.message : "Could not change the kill switch.",
    );
  }
}
