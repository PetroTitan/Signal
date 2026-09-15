"use server";

/**
 * Server actions for the LinkedIn Sales workspace.
 *
 * Every mutating action re-checks the session, the workspace and the
 * role (`edit_content`: owner, admin, editor). RLS and the SECURITY
 * DEFINER functions check again underneath; this layer exists so a
 * refusal is a sentence rather than a constraint error.
 *
 * NOTHING HERE TOUCHES LINKEDIN. "Open in LinkedIn" is a link the
 * operator follows; the action behind it records that they did.
 * "Mark completed" records the operator's own statement. There is no
 * code path from any action to any LinkedIn endpoint.
 */

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { recordActivity } from "@/repositories/activity-repository";
import { can } from "@/core/teams/permissions";
import type { LinkedInSequenceStepKind, LinkedInSourceType, WorkspaceRole } from "@/lib/supabase/types";
import { actionFail, actionOk, type ActionResult } from "@/lib/forms/action-result";
import { isValidTimezone, parseMinutes } from "@/core/bluesky-campaigns/campaign-day";
import { IMPORT_MAX_BYTES, importLeadsFromText } from "@/core/linkedin-sales/import.server";
import { isSequenceStepKind, MAX_SEQUENCE_STEPS, SELECTABLE_STEP_KINDS } from "@/core/linkedin-sales/state";
import { getActiveAiProvider, quickSafetyCheck } from "@/core/ai";
import {
  activateCampaign,
  cancelCampaign,
  confirmTask,
  createCampaign,
  createLeadList,
  createSequence,
  getCampaign,
  getTask,
  pauseCampaign,
  recordComplianceEvent,
  recordTaskCopied,
  recordTaskOpened,
  skipTask,
  suppressFromTask,
  type SequenceStepInput,
} from "@/repositories/linkedin-sales-repository";

type Ctx =
  | { kind: "ok"; workspaceId: string; userId: string; role: WorkspaceRole }
  | { kind: "error"; message: string };

const EDIT_REFUSAL = "Your role can view this workspace but not change it. Ask an owner, admin or editor.";

async function requireCtx(mode: "edit" | "view" = "edit"): Promise<Ctx> {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { kind: "error", message: "Sign in first." };
  const membership = await getPrimaryWorkspace();
  if (!membership) return { kind: "error", message: "No workspace found." };
  if (mode === "edit" && !can(membership.role, "edit_content")) {
    return { kind: "error", message: EDIT_REFUSAL };
  }
  return { kind: "ok", workspaceId: membership.workspace.id, userId: user.id, role: membership.role };
}

const str = (fd: FormData, key: string, max = 4000): string => {
  const v = fd.get(key);
  return typeof v === "string" ? v.trim().slice(0, max) : "";
};

const SOURCE_TYPES: LinkedInSourceType[] = ["customer_csv", "customer_pasted"];
const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

function revalidateAll() {
  for (const p of ["/linkedin", "/linkedin/leads", "/linkedin/sequences", "/linkedin/campaigns", "/linkedin/tasks", "/linkedin/analytics", "/linkedin/compliance"]) {
    revalidatePath(p);
  }
}

// ---------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------

export type CreateLeadListResult = ActionResult<{ leadListId: string }>;

export async function createLeadListAction(_prev: CreateLeadListResult, fd: FormData): Promise<CreateLeadListResult> {
  const ctx = await requireCtx();
  if (ctx.kind === "error") return actionFail(ctx.message);
  const name = str(fd, "name", 120);
  const sourceType = str(fd, "source_type") as LinkedInSourceType;
  const sourceNote = str(fd, "source_note", 1000);
  if (!name) return actionFail("Give the list a name.");
  if (!SOURCE_TYPES.includes(sourceType)) return actionFail("Say where the list comes from.");
  try {
    const list = await createLeadList({ workspaceId: ctx.workspaceId, name, sourceType, sourceNote: sourceNote || null, createdBy: ctx.userId });
    revalidateAll();
    return actionOk({ leadListId: list.id });
  } catch (err) {
    return actionFail(err instanceof Error ? err.message : "Could not create the list.");
  }
}

export type ImportResult = ActionResult<{
  jobId: string;
  inserted: number;
  duplicates: number;
  invalid: number;
  suppressed: number;
  alreadyImported: boolean;
  finished: boolean;
}>;

export async function importLeadsAction(_prev: ImportResult, fd: FormData): Promise<ImportResult> {
  const ctx = await requireCtx();
  if (ctx.kind === "error") return actionFail(ctx.message);
  const leadListId = str(fd, "lead_list_id", 64);
  if (!isUuid(leadListId)) return actionFail("Choose a list first.");
  const sourceType = str(fd, "source_type") as LinkedInSourceType;
  if (!SOURCE_TYPES.includes(sourceType)) return actionFail("Say where these profiles come from.");
  const processingBasisNote = str(fd, "processing_basis_note", 1000) || null;
  const retentionRaw = str(fd, "retention_until", 10);
  const retentionUntil = retentionRaw ? (/^\d{4}-\d{2}-\d{2}$/.test(retentionRaw) ? retentionRaw : null) : null;
  if (retentionRaw && !retentionUntil) return actionFail("The retention date must be a calendar date.");

  let text = "";
  let fileName: string | null = null;
  const file = fd.get("file");
  if (file instanceof File && file.size > 0) {
    if (file.size > IMPORT_MAX_BYTES) {
      return actionFail(`The file is ${file.size.toLocaleString("en-GB")} bytes; the limit is ${IMPORT_MAX_BYTES.toLocaleString("en-GB")}. Split it and import the parts.`);
    }
    text = await file.text();
    fileName = file.name.slice(0, 300);
  } else {
    text = str(fd, "pasted", IMPORT_MAX_BYTES);
  }
  if (!text.trim()) return actionFail("Choose a file or paste profile URLs.");

  try {
    const out = await importLeadsFromText({
      workspaceId: ctx.workspaceId, leadListId, sourceType, text, fileName, createdBy: ctx.userId, processingBasisNote, retentionUntil,
    });
    if (!out.ok) return actionFail(out.detail);
    if (!out.alreadyImported) {
      await recordActivity({
        workspaceId: ctx.workspaceId,
        eventType: "linkedin_leads_imported",
        entityType: "linkedin_import_job",
        entityId: out.job.id,
        title: `Imported ${out.job.inserted_count} LinkedIn leads`,
        description: `${out.job.duplicate_count} duplicates, ${out.job.invalid_count} invalid, ${out.job.suppressed_count} suppressed.`,
      });
    }
    revalidateAll();
    return actionOk({
      jobId: out.job.id,
      inserted: out.job.inserted_count,
      duplicates: out.job.duplicate_count,
      invalid: out.job.invalid_count,
      suppressed: out.job.suppressed_count,
      alreadyImported: out.alreadyImported,
      finished: out.finished,
    });
  } catch (err) {
    return actionFail(err instanceof Error ? err.message : "The import failed.");
  }
}

// ---------------------------------------------------------------------
// Sequences
// ---------------------------------------------------------------------

export type CreateSequenceResult = ActionResult<{ sequenceId: string }>;

export async function createSequenceAction(_prev: CreateSequenceResult, fd: FormData): Promise<CreateSequenceResult> {
  const ctx = await requireCtx();
  if (ctx.kind === "error") return actionFail(ctx.message);
  const name = str(fd, "name", 120);
  if (!name) return actionFail("Give the sequence a name.");
  const steps: SequenceStepInput[] = [];
  for (let i = 1; i <= MAX_SEQUENCE_STEPS; i += 1) {
    const kind = str(fd, `step_kind_${i}`, 64);
    if (!kind) continue;
    if (!isSequenceStepKind(kind) || !(SELECTABLE_STEP_KINDS as readonly string[]).includes(kind)) {
      return actionFail(`Step ${i} has a kind Signal cannot prepare.`);
    }
    const k = kind as LinkedInSequenceStepKind;
    const waitDays = Number(str(fd, `step_wait_${i}`, 4) || "0");
    const template = str(fd, `step_template_${i}`, 4000);
    if (k === "wait") {
      if (!Number.isInteger(waitDays) || waitDays < 0 || waitDays > 365) return actionFail(`Step ${i}: wait between 0 and 365 days.`);
    } else if (!template && k !== "manual_profile_review") {
      return actionFail(`Step ${i} needs a draft. You will copy it yourself when the task is ready.`);
    }
    steps.push({ position: steps.length + 1, kind: k, waitDays: k === "wait" ? waitDays : 0, template: k === "wait" ? null : template || null });
  }
  if (steps.length === 0) return actionFail("Add at least one step.");
  if (!steps.some((s) => s.kind !== "wait" && s.kind !== "internal_note")) {
    return actionFail("Add at least one step that is a task for you.");
  }
  try {
    const sequence = await createSequence({ workspaceId: ctx.workspaceId, name, steps, createdBy: ctx.userId });
    revalidateAll();
    return actionOk({ sequenceId: sequence.id });
  } catch (err) {
    return actionFail(err instanceof Error ? err.message : "Could not create the sequence.");
  }
}

// ---------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------

export type CampaignResult = ActionResult<{ campaignId: string; message: string }>;

export async function createCampaignAction(_prev: CampaignResult, fd: FormData): Promise<CampaignResult> {
  const ctx = await requireCtx();
  if (ctx.kind === "error") return actionFail(ctx.message);
  const name = str(fd, "name", 120);
  const leadListId = str(fd, "lead_list_id", 64);
  const sequenceId = str(fd, "sequence_id", 64);
  const timezone = str(fd, "timezone", 64);
  const start = parseMinutes(str(fd, "window_start", 5));
  const end = parseMinutes(str(fd, "window_end", 5));
  const target = Number(str(fd, "daily_task_target", 4));
  if (!name) return actionFail("Give the campaign a name.");
  if (!isUuid(leadListId)) return actionFail("Choose a lead list.");
  if (!isUuid(sequenceId)) return actionFail("Choose a sequence.");
  if (!isValidTimezone(timezone)) return actionFail("Choose a timezone.");
  if (start === null || end === null) return actionFail("Give the working window as HH:MM times.");
  if (end <= start) return actionFail("The window must end after it starts.");
  if (!Number.isInteger(target) || target < 1 || target > 200) return actionFail("Tasks per day must be between 1 and 200.");
  try {
    const campaign = await createCampaign({
      workspaceId: ctx.workspaceId, leadListId, sequenceId, name, timezone,
      windowStartMinute: start, windowEndMinute: end === 1440 ? 1440 : end, dailyTaskTarget: target, createdBy: ctx.userId,
    });
    revalidateAll();
    return actionOk({ campaignId: campaign.id, message: "Campaign saved as a draft. Nothing is prepared until you start it." });
  } catch (err) {
    return actionFail(err instanceof Error ? err.message : "Could not create the campaign.");
  }
}

const ACTIVATION_REFUSALS: Record<string, string> = {
  not_activatable: "This campaign cannot be started from its current state.",
  sequence_has_no_steps: "The sequence has no steps.",
  email_integration_unavailable: "The sequence has an email step and no email integration is authorized in this release.",
  list_has_no_leads: "The lead list is empty.",
  forbidden: EDIT_REFUSAL,
};

export async function activateCampaignAction(_prev: CampaignResult, fd: FormData): Promise<CampaignResult> {
  const ctx = await requireCtx();
  if (ctx.kind === "error") return actionFail(ctx.message);
  const campaignId = str(fd, "campaign_id", 64);
  if (!isUuid(campaignId)) return actionFail("Which campaign?");
  try {
    const out = await activateCampaign({ workspaceId: ctx.workspaceId, campaignId });
    if (!out.ok) return actionFail(ACTIVATION_REFUSALS[out.refusedReason ?? ""] ?? `Could not start: ${out.refusedReason}.`);
    await recordActivity({
      workspaceId: ctx.workspaceId, eventType: "linkedin_campaign_activated", entityType: "linkedin_campaign", entityId: campaignId,
      title: "LinkedIn campaign started", description: `${out.membersWaiting} people waiting, ${out.membersSuppressed} suppressed. Signal prepares manual tasks; you perform them.`,
    });
    revalidateAll();
    return actionOk({ campaignId, message: `Started. ${out.membersWaiting} people waiting, ${out.membersSuppressed} suppressed. Tasks appear in your working window.` });
  } catch (err) {
    return actionFail(err instanceof Error ? err.message : "Could not start the campaign.");
  }
}

export async function pauseCampaignAction(_prev: CampaignResult, fd: FormData): Promise<CampaignResult> {
  const ctx = await requireCtx();
  if (ctx.kind === "error") return actionFail(ctx.message);
  const campaignId = str(fd, "campaign_id", 64);
  if (!isUuid(campaignId)) return actionFail("Which campaign?");
  try {
    const row = await pauseCampaign({ workspaceId: ctx.workspaceId, campaignId });
    if (!row) return actionFail("Only a running campaign can be paused.");
    await recordComplianceEvent({ workspaceId: ctx.workspaceId, eventType: "campaign_paused", actorUserId: ctx.userId, entityType: "linkedin_campaign", entityId: campaignId });
    revalidateAll();
    return actionOk({ campaignId, message: "Paused. Open tasks stay open; nothing new is prepared." });
  } catch (err) {
    return actionFail(err instanceof Error ? err.message : "Could not pause the campaign.");
  }
}

export async function cancelCampaignAction(_prev: CampaignResult, fd: FormData): Promise<CampaignResult> {
  const ctx = await requireCtx();
  if (ctx.kind === "error") return actionFail(ctx.message);
  const campaignId = str(fd, "campaign_id", 64);
  if (!isUuid(campaignId)) return actionFail("Which campaign?");
  if (str(fd, "confirm", 8) !== "on") return actionFail("Tick the confirmation to cancel.");
  try {
    const campaign = await getCampaign({ workspaceId: ctx.workspaceId, campaignId });
    if (!campaign) return actionFail("Campaign not found.");
    const out = await cancelCampaign({ workspaceId: ctx.workspaceId, campaignId });
    if (!out.ok) return actionFail(out.refusedReason === "already_final" ? "This campaign has already ended." : `Could not cancel: ${out.refusedReason}.`);
    await recordActivity({
      workspaceId: ctx.workspaceId, eventType: "linkedin_campaign_cancelled", entityType: "linkedin_campaign", entityId: campaignId,
      title: `LinkedIn campaign "${campaign.name}" cancelled`, description: `${out.tasksCancelled} open tasks and ${out.membersCancelled} waiting people cancelled. History kept.`,
    });
    revalidateAll();
    return actionOk({ campaignId, message: `Cancelled. ${out.tasksCancelled} open tasks and ${out.membersCancelled} waiting people were cancelled; history is kept.` });
  } catch (err) {
    return actionFail(err instanceof Error ? err.message : "Could not cancel the campaign.");
  }
}

// ---------------------------------------------------------------------
// Tasks — the operator's own recordings
// ---------------------------------------------------------------------

export type TaskResult = ActionResult<{ taskId: string; message: string }>;

/** The operator followed "Open in LinkedIn". A recording; never completion. */
export async function recordOpenedAction(taskId: string): Promise<TaskResult> {
  const ctx = await requireCtx();
  if (ctx.kind === "error") return actionFail(ctx.message);
  if (!isUuid(taskId)) return actionFail("Which task?");
  try {
    const row = await recordTaskOpened({ workspaceId: ctx.workspaceId, taskId });
    if (row) {
      await recordComplianceEvent({ workspaceId: ctx.workspaceId, eventType: "task_opened", actorUserId: ctx.userId, entityType: "linkedin_manual_task", entityId: taskId });
    }
    revalidatePath("/linkedin/tasks");
    return actionOk({ taskId, message: "Recorded that you opened the profile. Nothing was sent." });
  } catch (err) {
    return actionFail(err instanceof Error ? err.message : "Could not record the open.");
  }
}

/** The operator copied the draft. A recording; never "sent". */
export async function recordCopiedAction(taskId: string): Promise<TaskResult> {
  const ctx = await requireCtx();
  if (ctx.kind === "error") return actionFail(ctx.message);
  if (!isUuid(taskId)) return actionFail("Which task?");
  try {
    const row = await recordTaskCopied({ workspaceId: ctx.workspaceId, taskId });
    if (row) {
      await recordComplianceEvent({ workspaceId: ctx.workspaceId, eventType: "task_copied", actorUserId: ctx.userId, entityType: "linkedin_manual_task", entityId: taskId });
    }
    revalidatePath("/linkedin/tasks");
    return actionOk({ taskId, message: "Draft copied. Nothing was sent." });
  } catch (err) {
    return actionFail(err instanceof Error ? err.message : "Could not record the copy.");
  }
}

const CONFIRM_REFUSALS: Record<string, string> = {
  not_found: "Task not found.",
  not_confirmable: "This task is not open any more.",
  forbidden: EDIT_REFUSAL,
};

/** The operator states they performed the step on LinkedIn themselves. */
export async function confirmTaskAction(_prev: TaskResult, fd: FormData): Promise<TaskResult> {
  const ctx = await requireCtx();
  if (ctx.kind === "error") return actionFail(ctx.message);
  const taskId = str(fd, "task_id", 64);
  if (!isUuid(taskId)) return actionFail("Which task?");
  if (str(fd, "attest", 8) !== "on") return actionFail("Tick the box to confirm you did this step on LinkedIn yourself.");
  try {
    const out = await confirmTask({ workspaceId: ctx.workspaceId, taskId });
    if (!out.ok) return actionFail(CONFIRM_REFUSALS[out.refusedReason ?? ""] ?? `Could not confirm: ${out.refusedReason}.`);
    revalidateAll();
    return actionOk({ taskId, message: out.memberState === "completed" ? "Confirmed. That was the last step for this person." : "Confirmed. The next step will be prepared when it is due." });
  } catch (err) {
    return actionFail(err instanceof Error ? err.message : "Could not confirm the task.");
  }
}

export async function skipTaskAction(_prev: TaskResult, fd: FormData): Promise<TaskResult> {
  const ctx = await requireCtx();
  if (ctx.kind === "error") return actionFail(ctx.message);
  const taskId = str(fd, "task_id", 64);
  const reason = str(fd, "reason", 500);
  if (!isUuid(taskId)) return actionFail("Which task?");
  if (!reason) return actionFail("Say why you are skipping. The reason is kept with the task.");
  try {
    const out = await skipTask({ workspaceId: ctx.workspaceId, taskId, reason });
    if (!out.ok) return actionFail(CONFIRM_REFUSALS[out.refusedReason ?? ""] ?? `Could not skip: ${out.refusedReason}.`);
    revalidateAll();
    return actionOk({ taskId, message: "Skipped. This person will not get further steps in this campaign." });
  } catch (err) {
    return actionFail(err instanceof Error ? err.message : "Could not skip the task.");
  }
}

export async function suppressFromTaskAction(_prev: TaskResult, fd: FormData): Promise<TaskResult> {
  const ctx = await requireCtx();
  if (ctx.kind === "error") return actionFail(ctx.message);
  const taskId = str(fd, "task_id", 64);
  const reason = str(fd, "reason", 500);
  if (!isUuid(taskId)) return actionFail("Which task?");
  if (str(fd, "confirm", 8) !== "on") return actionFail("Tick the confirmation to add this person to the suppression list.");
  try {
    const out = await suppressFromTask({ workspaceId: ctx.workspaceId, taskId, reason: reason || null });
    if (!out.ok) return actionFail(CONFIRM_REFUSALS[out.refusedReason ?? ""] ?? `Could not suppress: ${out.refusedReason}.`);
    revalidateAll();
    return actionOk({ taskId, message: "Added to the suppression list. No campaign in this workspace will prepare a task for this person again." });
  } catch (err) {
    return actionFail(err instanceof Error ? err.message : "Could not add to the suppression list.");
  }
}

// ---------------------------------------------------------------------
// AI-assisted draft: a suggestion the operator reviews. Never sent.
// ---------------------------------------------------------------------

export type SuggestResult = ActionResult<{ taskId: string; text: string; flags: string[]; providerLabel: string }>;

export async function suggestDraftAction(_prev: SuggestResult, fd: FormData): Promise<SuggestResult> {
  const ctx = await requireCtx();
  if (ctx.kind === "error") return actionFail(ctx.message);
  const taskId = str(fd, "task_id", 64);
  if (!isUuid(taskId)) return actionFail("Which task?");
  try {
    const task = await getTask({ workspaceId: ctx.workspaceId, taskId });
    if (!task) return actionFail("Task not found.");
    if (!task.draft_text) return actionFail("This task has no draft to work from.");
    const provider = getActiveAiProvider();
    const result = await provider.generate("draft_variant", {
      insightTitle: "A calmer variant of a message the operator will send personally",
      insightBody: task.draft_text,
      platform: "linkedin",
      contentType: task.kind,
    });
    if (!result.ok) return actionFail(`No suggestion: ${result.error.message}`);
    const text = result.payload.body.slice(0, 4000);
    const safety = quickSafetyCheck(text);
    if (safety.blocked) return actionFail("The suggestion was blocked by the safety policy. Use your own words.");
    return actionOk({ taskId, text, flags: safety.flags, providerLabel: provider.meta.label });
  } catch (err) {
    return actionFail(err instanceof Error ? err.message : "Could not produce a suggestion.");
  }
}
