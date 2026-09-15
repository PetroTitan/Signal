import "server-only";
/**
 * LinkedIn Sales Workspace — every read and write, workspace-scoped.
 *
 * RLS is the boundary; every query here filters by workspace_id as
 * well, because the scheduler runs as the service role (which bypasses
 * policies) and on that path the filter is the only line.
 *
 * Paging is KEYSET everywhere. A lead list may hold tens of thousands
 * of rows and members move between states while a page is open; a
 * page keyed on (created_at, id) or (available_at, id) neither skips
 * nor repeats a row. Nothing here skips a numbered count of rows, and
 * a structural test keeps it that way.
 *
 * Nothing in this file talks to LinkedIn. There is nothing to talk with.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase";
import { fromPostgres } from "./errors";
import type {
  LinkedInCampaignMemberRow,
  LinkedInCampaignRow,
  LinkedInCampaignStatus,
  LinkedInComplianceEventRow,
  LinkedInComplianceEventType,
  LinkedInImportJobRow,
  LinkedInLeadListRow,
  LinkedInLeadRow,
  LinkedInManualTaskRow,
  LinkedInMemberState,
  LinkedInSequenceRow,
  LinkedInSequenceStepKind,
  LinkedInSequenceStepRow,
  LinkedInSourceType,
  LinkedInSuppressionEntryRow,
  LinkedInTaskState,
} from "@/lib/supabase/types";

type Db = SupabaseClient | undefined;
const client = (db: Db): SupabaseClient => db ?? createSupabaseServerClient();

export const LEAD_PAGE_SIZE = 50;
export const TASK_PAGE_SIZE = 50;
export const EVENT_PAGE_SIZE = 50;

// =====================================================================
// Lead lists
// =====================================================================

export async function createLeadList(input: {
  workspaceId: string;
  name: string;
  sourceType: LinkedInSourceType;
  sourceNote?: string | null;
  createdBy?: string | null;
  db?: Db;
}): Promise<LinkedInLeadListRow> {
  const { data, error } = await client(input.db)
    .from("linkedin_lead_lists")
    .insert({
      workspace_id: input.workspaceId,
      name: input.name,
      source_type: input.sourceType,
      source_note: input.sourceNote ?? null,
      created_by: input.createdBy ?? null,
    } as never)
    .select("*")
    .single();
  if (error || !data) throw fromPostgres(error, "Could not create the lead list.");
  return data as unknown as LinkedInLeadListRow;
}

export async function listLeadLists(input: { workspaceId: string; db?: Db }): Promise<LinkedInLeadListRow[]> {
  const { data, error } = await client(input.db)
    .from("linkedin_lead_lists")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .limit(100);
  if (error) throw fromPostgres(error, "Could not list lead lists.");
  return (data ?? []) as unknown as LinkedInLeadListRow[];
}

export async function getLeadList(input: { workspaceId: string; leadListId: string; db?: Db }): Promise<LinkedInLeadListRow | null> {
  const { data, error } = await client(input.db)
    .from("linkedin_lead_lists")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.leadListId)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Could not read the lead list.");
  return (data as unknown as LinkedInLeadListRow) ?? null;
}

// =====================================================================
// Leads
// =====================================================================

export interface LeadInsert {
  profileKey: string;
  canonicalProfileUrl: string;
  name?: string | null;
  company?: string | null;
  title?: string | null;
  sourceType: LinkedInSourceType;
  sourceReference?: string | null;
  processingBasisNote?: string | null;
  doNotContact?: boolean;
  doNotContactReason?: string | null;
  retentionUntil?: string | null;
}

/**
 * Insert a chunk, idempotently. A row whose (list, profile_key) already
 * exists is left as it is and reported as a duplicate. Returns the
 * keys that were actually inserted so the caller can count.
 */
export async function insertLeadsChunk(input: {
  workspaceId: string;
  leadListId: string;
  leads: LeadInsert[];
  db?: Db;
}): Promise<{ insertedKeys: string[] }> {
  if (input.leads.length === 0) return { insertedKeys: [] };
  const rows = input.leads.map((l) => ({
    workspace_id: input.workspaceId,
    lead_list_id: input.leadListId,
    profile_key: l.profileKey,
    canonical_profile_url: l.canonicalProfileUrl,
    customer_provided_name: l.name ?? null,
    customer_provided_company: l.company ?? null,
    customer_provided_title: l.title ?? null,
    source_type: l.sourceType,
    source_reference: l.sourceReference ?? null,
    processing_basis_note: l.processingBasisNote ?? null,
    do_not_contact: l.doNotContact ?? false,
    do_not_contact_reason: l.doNotContactReason ?? null,
    retention_until: l.retentionUntil ?? null,
  }));
  const { data, error } = await client(input.db)
    .from("linkedin_leads")
    .upsert(rows as never, { onConflict: "workspace_id,lead_list_id,profile_key", ignoreDuplicates: true })
    .select("profile_key");
  if (error) throw fromPostgres(error, "Could not insert leads.");
  return { insertedKeys: ((data ?? []) as { profile_key: string }[]).map((r) => r.profile_key) };
}

export interface LeadCursor {
  createdAt: string;
  id: string;
}

export async function listLeadsKeyset(input: {
  workspaceId: string;
  leadListId: string;
  after?: LeadCursor | null;
  pageSize?: number;
  db?: Db;
}): Promise<{ rows: LinkedInLeadRow[]; nextCursor: LeadCursor | null }> {
  const pageSize = Math.min(Math.max(input.pageSize ?? LEAD_PAGE_SIZE, 1), 200);
  let query = client(input.db)
    .from("linkedin_leads")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .eq("lead_list_id", input.leadListId);
  if (input.after) {
    // (created_at, id) > (after.createdAt, after.id)
    query = query.or(
      `created_at.gt.${input.after.createdAt},and(created_at.eq.${input.after.createdAt},id.gt.${input.after.id})`,
    );
  }
  const { data, error } = await query
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(pageSize + 1);
  if (error) throw fromPostgres(error, "Could not list leads.");
  const rows = (data ?? []) as unknown as LinkedInLeadRow[];
  const page = rows.slice(0, pageSize);
  const last = page[page.length - 1];
  return {
    rows: page,
    nextCursor: rows.length > pageSize && last ? { createdAt: last.created_at, id: last.id } : null,
  };
}

export async function countLeads(input: { workspaceId: string; leadListId?: string | null; db?: Db }): Promise<{
  total: number;
  doNotContact: number;
}> {
  const base = () => {
    let q = client(input.db).from("linkedin_leads").select("id", { count: "exact", head: true }).eq("workspace_id", input.workspaceId);
    if (input.leadListId) q = q.eq("lead_list_id", input.leadListId);
    return q;
  };
  const [all, dnc] = await Promise.all([base(), base().eq("do_not_contact", true)]);
  if (all.error) throw fromPostgres(all.error, "Could not count leads.");
  if (dnc.error) throw fromPostgres(dnc.error, "Could not count leads.");
  return { total: all.count ?? 0, doNotContact: dnc.count ?? 0 };
}

/** Leads past their retention date, workspace-wide. Deleted in bounded chunks by keyset. */
export async function deleteExpiredLeads(input: {
  workspaceId: string;
  today: string;
  limit?: number;
  db?: Db;
}): Promise<{ deleted: number; profileKeys: string[] }> {
  const limit = Math.min(Math.max(input.limit ?? 500, 1), 1000);
  const { data: due, error } = await client(input.db)
    .from("linkedin_leads")
    .select("id, profile_key")
    .eq("workspace_id", input.workspaceId)
    .lte("retention_until", input.today)
    .order("retention_until", { ascending: true })
    .order("id", { ascending: true })
    .limit(limit);
  if (error) throw fromPostgres(error, "Could not read expired leads.");
  const ids = ((due ?? []) as { id: string; profile_key: string }[]);
  if (ids.length === 0) return { deleted: 0, profileKeys: [] };
  const { error: delError } = await client(input.db)
    .from("linkedin_leads")
    .delete()
    .eq("workspace_id", input.workspaceId)
    .in("id", ids.map((r) => r.id));
  if (delError) throw fromPostgres(delError, "Could not delete expired leads.");
  return { deleted: ids.length, profileKeys: ids.map((r) => r.profile_key) };
}

/** Deletion request for one profile: every lead row for that key, every list. */
export async function deleteLeadsByProfileKey(input: {
  workspaceId: string;
  profileKey: string;
  db?: Db;
}): Promise<number> {
  const { data, error } = await client(input.db)
    .from("linkedin_leads")
    .delete()
    .eq("workspace_id", input.workspaceId)
    .eq("profile_key", input.profileKey)
    .select("id");
  if (error) throw fromPostgres(error, "Could not delete the lead.");
  return (data ?? []).length;
}

// =====================================================================
// Suppression
// =====================================================================

export async function listSuppression(input: { workspaceId: string; limit?: number; db?: Db }): Promise<LinkedInSuppressionEntryRow[]> {
  const { data, error } = await client(input.db)
    .from("linkedin_suppression_entries")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .limit(Math.min(Math.max(input.limit ?? 200, 1), 1000));
  if (error) throw fromPostgres(error, "Could not list the suppression list.");
  return (data ?? []) as unknown as LinkedInSuppressionEntryRow[];
}

/** Which of these keys are suppressed. Chunked so a 10,000-key import stays under the URL limit. */
export async function suppressedKeysAmong(input: { workspaceId: string; profileKeys: string[]; db?: Db }): Promise<Set<string>> {
  const out = new Set<string>();
  const unique = [...new Set(input.profileKeys)];
  for (let i = 0; i < unique.length; i += 200) {
    const chunk = unique.slice(i, i + 200);
    const { data, error } = await client(input.db)
      .from("linkedin_suppression_entries")
      .select("profile_key")
      .eq("workspace_id", input.workspaceId)
      .in("profile_key", chunk);
    if (error) throw fromPostgres(error, "Could not check the suppression list.");
    for (const r of (data ?? []) as { profile_key: string }[]) out.add(r.profile_key);
  }
  return out;
}

export async function addSuppression(input: {
  workspaceId: string;
  profileKey: string;
  canonicalProfileUrl: string;
  reason?: string | null;
  source: LinkedInSuppressionEntryRow["source"];
  createdBy?: string | null;
  db?: Db;
}): Promise<{ added: boolean }> {
  const { data, error } = await client(input.db)
    .from("linkedin_suppression_entries")
    .upsert(
      {
        workspace_id: input.workspaceId,
        profile_key: input.profileKey,
        canonical_profile_url: input.canonicalProfileUrl,
        reason: input.reason ?? null,
        source: input.source,
        created_by: input.createdBy ?? null,
      } as never,
      { onConflict: "workspace_id,profile_key", ignoreDuplicates: true },
    )
    .select("id");
  if (error) throw fromPostgres(error, "Could not add to the suppression list.");
  return { added: (data ?? []).length > 0 };
}

export async function removeSuppression(input: { workspaceId: string; profileKey: string; db?: Db }): Promise<boolean> {
  const { data, error } = await client(input.db)
    .from("linkedin_suppression_entries")
    .delete()
    .eq("workspace_id", input.workspaceId)
    .eq("profile_key", input.profileKey)
    .select("id");
  if (error) throw fromPostgres(error, "Could not remove from the suppression list.");
  return (data ?? []).length > 0;
}

/** Mark every lead row for a key do-not-contact (the suppression list is the authority; this is the visible flag). */
export async function markLeadsDoNotContact(input: {
  workspaceId: string;
  profileKey: string;
  reason: string;
  db?: Db;
}): Promise<void> {
  const { error } = await client(input.db)
    .from("linkedin_leads")
    .update({ do_not_contact: true, do_not_contact_reason: input.reason } as never)
    .eq("workspace_id", input.workspaceId)
    .eq("profile_key", input.profileKey);
  if (error) throw fromPostgres(error, "Could not mark the lead.");
}

// =====================================================================
// Sequences
// =====================================================================

export interface SequenceStepInput {
  position: number;
  kind: LinkedInSequenceStepKind;
  waitDays?: number;
  template?: string | null;
  requiredConfirmation?: boolean;
}

export async function createSequence(input: {
  workspaceId: string;
  name: string;
  steps: SequenceStepInput[];
  createdBy?: string | null;
  db?: Db;
}): Promise<LinkedInSequenceRow> {
  const { data, error } = await client(input.db)
    .from("linkedin_sequences")
    .insert({ workspace_id: input.workspaceId, name: input.name, created_by: input.createdBy ?? null, status: "draft" } as never)
    .select("*")
    .single();
  if (error || !data) throw fromPostgres(error, "Could not create the sequence.");
  const sequence = data as unknown as LinkedInSequenceRow;
  await replaceSequenceSteps({ workspaceId: input.workspaceId, sequenceId: sequence.id, steps: input.steps, db: input.db });
  return sequence;
}

export async function replaceSequenceSteps(input: {
  workspaceId: string;
  sequenceId: string;
  steps: SequenceStepInput[];
  db?: Db;
}): Promise<void> {
  const db = client(input.db);
  const { error: delError } = await db
    .from("linkedin_sequence_steps")
    .delete()
    .eq("workspace_id", input.workspaceId)
    .eq("sequence_id", input.sequenceId);
  if (delError) throw fromPostgres(delError, "Could not replace the steps.");
  if (input.steps.length === 0) return;
  const rows = input.steps.map((s) => ({
    workspace_id: input.workspaceId,
    sequence_id: input.sequenceId,
    position: s.position,
    kind: s.kind,
    wait_days: s.kind === "wait" ? (s.waitDays ?? 0) : 0,
    template: s.kind === "wait" ? null : (s.template ?? null),
    required_confirmation: s.requiredConfirmation ?? true,
  }));
  const { error } = await db.from("linkedin_sequence_steps").insert(rows as never);
  if (error) throw fromPostgres(error, "Could not save the steps.");
}

export async function listSequences(input: { workspaceId: string; db?: Db }): Promise<LinkedInSequenceRow[]> {
  const { data, error } = await client(input.db)
    .from("linkedin_sequences")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .limit(100);
  if (error) throw fromPostgres(error, "Could not list sequences.");
  return (data ?? []) as unknown as LinkedInSequenceRow[];
}

export async function listSequenceSteps(input: { workspaceId: string; sequenceId: string; db?: Db }): Promise<LinkedInSequenceStepRow[]> {
  const { data, error } = await client(input.db)
    .from("linkedin_sequence_steps")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .eq("sequence_id", input.sequenceId)
    .order("position", { ascending: true });
  if (error) throw fromPostgres(error, "Could not list the steps.");
  return (data ?? []) as unknown as LinkedInSequenceStepRow[];
}

// =====================================================================
// Campaigns
// =====================================================================

export async function createCampaign(input: {
  workspaceId: string;
  leadListId: string;
  sequenceId: string;
  name: string;
  timezone: string;
  windowStartMinute: number;
  windowEndMinute: number;
  dailyTaskTarget: number;
  createdBy?: string | null;
  db?: Db;
}): Promise<LinkedInCampaignRow> {
  const { data, error } = await client(input.db)
    .from("linkedin_campaigns")
    .insert({
      workspace_id: input.workspaceId,
      lead_list_id: input.leadListId,
      sequence_id: input.sequenceId,
      name: input.name,
      timezone: input.timezone,
      working_window_start_minute: input.windowStartMinute,
      working_window_end_minute: input.windowEndMinute,
      daily_task_target: input.dailyTaskTarget,
      created_by: input.createdBy ?? null,
    } as never)
    .select("*")
    .single();
  if (error || !data) throw fromPostgres(error, "Could not create the campaign.");
  return data as unknown as LinkedInCampaignRow;
}

export async function listCampaigns(input: { workspaceId: string; statuses?: LinkedInCampaignStatus[]; db?: Db }): Promise<LinkedInCampaignRow[]> {
  let q = client(input.db).from("linkedin_campaigns").select("*").eq("workspace_id", input.workspaceId);
  if (input.statuses && input.statuses.length > 0) q = q.in("status", input.statuses);
  const { data, error } = await q.order("created_at", { ascending: false }).order("id", { ascending: true }).limit(100);
  if (error) throw fromPostgres(error, "Could not list campaigns.");
  return (data ?? []) as unknown as LinkedInCampaignRow[];
}

export async function getCampaign(input: { workspaceId: string; campaignId: string; db?: Db }): Promise<LinkedInCampaignRow | null> {
  const { data, error } = await client(input.db)
    .from("linkedin_campaigns")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.campaignId)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Could not read the campaign.");
  return (data as unknown as LinkedInCampaignRow) ?? null;
}

/** Guarded: only an active campaign pauses. Returns null when the guard refused. */
export async function pauseCampaign(input: { workspaceId: string; campaignId: string; db?: Db }): Promise<LinkedInCampaignRow | null> {
  const { data, error } = await client(input.db)
    .from("linkedin_campaigns")
    .update({ status: "paused", paused_at: new Date().toISOString() } as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.campaignId)
    .eq("status", "active")
    .select("*")
    .maybeSingle();
  if (error) throw fromPostgres(error, "Could not pause the campaign.");
  return (data as unknown as LinkedInCampaignRow) ?? null;
}

export interface ActivationOutcome {
  ok: boolean;
  refusedReason: string | null;
  membersWaiting: number;
  membersSuppressed: number;
  status: LinkedInCampaignStatus | null;
}

export async function activateCampaign(input: { workspaceId: string; campaignId: string; db?: Db }): Promise<ActivationOutcome> {
  const { data, error } = await client(input.db).rpc("activate_linkedin_campaign", {
    p_workspace_id: input.workspaceId,
    p_campaign_id: input.campaignId,
  });
  if (error) throw fromPostgres(error, "Could not activate the campaign.");
  const row = (Array.isArray(data) ? data[0] : data) as {
    ok: boolean; refused_reason: string | null; members_waiting: number; members_suppressed: number; status: string | null;
  };
  return {
    ok: Boolean(row?.ok),
    refusedReason: row?.refused_reason ?? null,
    membersWaiting: Number(row?.members_waiting ?? 0),
    membersSuppressed: Number(row?.members_suppressed ?? 0),
    status: (row?.status as LinkedInCampaignStatus | null) ?? null,
  };
}

export async function cancelCampaign(input: { workspaceId: string; campaignId: string; db?: Db }): Promise<{
  ok: boolean; refusedReason: string | null; tasksCancelled: number; membersCancelled: number;
}> {
  const { data, error } = await client(input.db).rpc("cancel_linkedin_campaign", {
    p_workspace_id: input.workspaceId,
    p_campaign_id: input.campaignId,
  });
  if (error) throw fromPostgres(error, "Could not cancel the campaign.");
  const row = (Array.isArray(data) ? data[0] : data) as {
    ok: boolean; refused_reason: string | null; tasks_cancelled: number; members_cancelled: number;
  };
  return {
    ok: Boolean(row?.ok),
    refusedReason: row?.refused_reason ?? null,
    tasksCancelled: Number(row?.tasks_cancelled ?? 0),
    membersCancelled: Number(row?.members_cancelled ?? 0),
  };
}

export interface CampaignConservation {
  membersTotal: number;
  waiting: number;
  completed: number;
  suppressed: number;
  operatorSkipped: number;
  structurallyInvalid: number;
  cancelled: number;
  tasksOpen: number;
  tasksConfirmed: number;
  tasksSkipped: number;
  tasksCancelled: number;
}

export async function campaignConservation(input: { workspaceId: string; campaignId: string; db?: Db }): Promise<CampaignConservation> {
  const { data, error } = await client(input.db).rpc("linkedin_campaign_conservation", {
    p_workspace_id: input.workspaceId,
    p_campaign_id: input.campaignId,
  });
  if (error) throw fromPostgres(error, "Could not read the campaign's state.");
  const r = (Array.isArray(data) ? data[0] : data) as Record<string, number | string>;
  const n = (k: string) => Number(r?.[k] ?? 0);
  return {
    membersTotal: n("members_total"), waiting: n("waiting"), completed: n("completed"), suppressed: n("suppressed"),
    operatorSkipped: n("operator_skipped"), structurallyInvalid: n("structurally_invalid"), cancelled: n("cancelled"),
    tasksOpen: n("tasks_open"), tasksConfirmed: n("tasks_confirmed"), tasksSkipped: n("tasks_skipped"), tasksCancelled: n("tasks_cancelled"),
  };
}

export interface MemberCursor { id: string }

export async function listMembersKeyset(input: {
  workspaceId: string;
  campaignId: string;
  state?: LinkedInMemberState | null;
  after?: MemberCursor | null;
  pageSize?: number;
  db?: Db;
}): Promise<{ rows: LinkedInCampaignMemberRow[]; nextCursor: MemberCursor | null }> {
  const pageSize = Math.min(Math.max(input.pageSize ?? LEAD_PAGE_SIZE, 1), 200);
  let q = client(input.db).from("linkedin_campaign_members").select("*").eq("workspace_id", input.workspaceId).eq("campaign_id", input.campaignId);
  if (input.state) q = q.eq("state", input.state);
  if (input.after) q = q.gt("id", input.after.id);
  const { data, error } = await q.order("id", { ascending: true }).limit(pageSize + 1);
  if (error) throw fromPostgres(error, "Could not list members.");
  const rows = (data ?? []) as unknown as LinkedInCampaignMemberRow[];
  const page = rows.slice(0, pageSize);
  return { rows: page, nextCursor: rows.length > pageSize ? { id: page[page.length - 1].id } : null };
}

// =====================================================================
// Manual tasks
// =====================================================================

export interface TaskCursor { availableAt: string; id: string }

export async function listTasksKeyset(input: {
  workspaceId: string;
  states: LinkedInTaskState[];
  campaignId?: string | null;
  after?: TaskCursor | null;
  pageSize?: number;
  db?: Db;
}): Promise<{ rows: LinkedInManualTaskRow[]; nextCursor: TaskCursor | null }> {
  const pageSize = Math.min(Math.max(input.pageSize ?? TASK_PAGE_SIZE, 1), 200);
  let q = client(input.db).from("linkedin_manual_tasks").select("*").eq("workspace_id", input.workspaceId).in("state", input.states);
  if (input.campaignId) q = q.eq("campaign_id", input.campaignId);
  if (input.after) {
    q = q.or(`available_at.gt.${input.after.availableAt},and(available_at.eq.${input.after.availableAt},id.gt.${input.after.id})`);
  }
  const { data, error } = await q.order("available_at", { ascending: true }).order("id", { ascending: true }).limit(pageSize + 1);
  if (error) throw fromPostgres(error, "Could not list tasks.");
  const rows = (data ?? []) as unknown as LinkedInManualTaskRow[];
  const page = rows.slice(0, pageSize);
  const last = page[page.length - 1];
  return { rows: page, nextCursor: rows.length > pageSize && last ? { availableAt: last.available_at, id: last.id } : null };
}

export async function getTask(input: { workspaceId: string; taskId: string; db?: Db }): Promise<LinkedInManualTaskRow | null> {
  const { data, error } = await client(input.db)
    .from("linkedin_manual_tasks")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.taskId)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Could not read the task.");
  return (data as unknown as LinkedInManualTaskRow) ?? null;
}

export async function countTasksByState(input: { workspaceId: string; campaignId?: string | null; db?: Db }): Promise<Record<LinkedInTaskState, number>> {
  const states: LinkedInTaskState[] = ["scheduled", "ready", "opened", "copied", "operator_confirmed", "skipped", "cancelled"];
  const out = {} as Record<LinkedInTaskState, number>;
  await Promise.all(states.map(async (s) => {
    let q = client(input.db).from("linkedin_manual_tasks").select("id", { count: "exact", head: true }).eq("workspace_id", input.workspaceId).eq("state", s);
    if (input.campaignId) q = q.eq("campaign_id", input.campaignId);
    const { count, error } = await q;
    if (error) throw fromPostgres(error, "Could not count tasks.");
    out[s] = count ?? 0;
  }));
  return out;
}

/**
 * Record that the operator opened the profile in LinkedIn. A RECORDING:
 * it moves ready → opened and stamps the time. It never completes the
 * task and never touches the member.
 */
export async function recordTaskOpened(input: { workspaceId: string; taskId: string; db?: Db }): Promise<LinkedInManualTaskRow | null> {
  const db = client(input.db);
  const now = new Date().toISOString();
  // From ready: state becomes opened. From opened/copied: only the timestamp refreshes if unset.
  const { data, error } = await db
    .from("linkedin_manual_tasks")
    .update({ state: "opened", opened_at: now } as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.taskId)
    .eq("state", "ready")
    .select("*")
    .maybeSingle();
  if (error) throw fromPostgres(error, "Could not record the open.");
  if (data) return data as unknown as LinkedInManualTaskRow;
  const { data: later, error: e2 } = await db
    .from("linkedin_manual_tasks")
    .update({ opened_at: now } as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.taskId)
    .in("state", ["opened", "copied"])
    .is("opened_at", null)
    .select("*")
    .maybeSingle();
  if (e2) throw fromPostgres(e2, "Could not record the open.");
  return (later as unknown as LinkedInManualTaskRow) ?? null;
}

/** Record that the operator copied the draft. A recording; never "sent". */
export async function recordTaskCopied(input: { workspaceId: string; taskId: string; db?: Db }): Promise<LinkedInManualTaskRow | null> {
  const { data, error } = await client(input.db)
    .from("linkedin_manual_tasks")
    .update({ state: "copied", copied_at: new Date().toISOString() } as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.taskId)
    .in("state", ["ready", "opened"])
    .select("*")
    .maybeSingle();
  if (error) throw fromPostgres(error, "Could not record the copy.");
  return (data as unknown as LinkedInManualTaskRow) ?? null;
}

export async function confirmTask(input: { workspaceId: string; taskId: string; db?: Db }): Promise<{ ok: boolean; refusedReason: string | null; memberState: string | null }> {
  const { data, error } = await client(input.db).rpc("confirm_linkedin_task", { p_workspace_id: input.workspaceId, p_task_id: input.taskId });
  if (error) throw fromPostgres(error, "Could not confirm the task.");
  const row = (Array.isArray(data) ? data[0] : data) as { ok: boolean; refused_reason: string | null; member_state: string | null };
  return { ok: Boolean(row?.ok), refusedReason: row?.refused_reason ?? null, memberState: row?.member_state ?? null };
}

export async function skipTask(input: { workspaceId: string; taskId: string; reason: string; db?: Db }): Promise<{ ok: boolean; refusedReason: string | null }> {
  const { data, error } = await client(input.db).rpc("skip_linkedin_task", { p_workspace_id: input.workspaceId, p_task_id: input.taskId, p_reason: input.reason });
  if (error) throw fromPostgres(error, "Could not skip the task.");
  const row = (Array.isArray(data) ? data[0] : data) as { ok: boolean; refused_reason: string | null };
  return { ok: Boolean(row?.ok), refusedReason: row?.refused_reason ?? null };
}

export async function suppressFromTask(input: { workspaceId: string; taskId: string; reason?: string | null; db?: Db }): Promise<{ ok: boolean; refusedReason: string | null }> {
  const { data, error } = await client(input.db).rpc("suppress_linkedin_lead_from_task", {
    p_workspace_id: input.workspaceId, p_task_id: input.taskId, p_reason: input.reason ?? null,
  });
  if (error) throw fromPostgres(error, "Could not add to the suppression list.");
  const row = (Array.isArray(data) ? data[0] : data) as { ok: boolean; refused_reason: string | null };
  return { ok: Boolean(row?.ok), refusedReason: row?.refused_reason ?? null };
}

// =====================================================================
// Import jobs
// =====================================================================

export async function findImportJobByFingerprint(input: { workspaceId: string; leadListId: string; fingerprint: string; db?: Db }): Promise<LinkedInImportJobRow | null> {
  const { data, error } = await client(input.db)
    .from("linkedin_import_jobs")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .eq("lead_list_id", input.leadListId)
    .eq("file_fingerprint", input.fingerprint)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Could not read the import job.");
  return (data as unknown as LinkedInImportJobRow) ?? null;
}

export async function createImportJob(input: {
  workspaceId: string;
  leadListId: string;
  sourceType: LinkedInSourceType;
  fileName: string | null;
  fingerprint: string;
  totalRows: number;
  createdBy?: string | null;
  db?: Db;
}): Promise<LinkedInImportJobRow> {
  const { data, error } = await client(input.db)
    .from("linkedin_import_jobs")
    .insert({
      workspace_id: input.workspaceId,
      lead_list_id: input.leadListId,
      source_type: input.sourceType,
      file_name: input.fileName,
      file_fingerprint: input.fingerprint,
      total_rows: input.totalRows,
      created_by: input.createdBy ?? null,
    } as never)
    .select("*")
    .single();
  if (error || !data) throw fromPostgres(error, "Could not start the import.");
  return data as unknown as LinkedInImportJobRow;
}

export interface ImportChunkRow {
  profile_key: string;
  canonical_profile_url: string;
  name: string | null;
  company: string | null;
  title: string | null;
}

export interface ImportChunkOutcome {
  /** False when the job had already passed this cursor: nothing was re-applied. */
  applied: boolean;
  inserted: number;
  duplicates: number;
  suppressed: number;
  status: LinkedInImportJobRow["status"];
  nextCursorRow: number;
}

/**
 * Apply one chunk atomically (rows + cursor + counts in one transaction
 * inside PostgreSQL). Idempotent by cursor: re-sending an applied chunk
 * is acknowledged, not repeated.
 */
export async function applyImportChunk(input: {
  workspaceId: string;
  jobId: string;
  rows: ImportChunkRow[];
  nextCursorRow: number;
  invalid: number;
  errors: { row: number; value: string; reason: string }[];
  done: boolean;
  db?: Db;
}): Promise<ImportChunkOutcome> {
  const { data, error } = await client(input.db).rpc("linkedin_apply_import_chunk", {
    p_workspace_id: input.workspaceId,
    p_job_id: input.jobId,
    p_rows: input.rows,
    p_next_cursor_row: input.nextCursorRow,
    p_invalid: input.invalid,
    p_errors: input.errors,
    p_done: input.done,
  });
  if (error) throw fromPostgres(error, "Could not record the imported rows.");
  const r = (Array.isArray(data) ? data[0] : data) as {
    applied: boolean; inserted: number; duplicates: number; suppressed: number; job_status: string; next_cursor_row: number;
  };
  return {
    applied: Boolean(r?.applied),
    inserted: Number(r?.inserted ?? 0),
    duplicates: Number(r?.duplicates ?? 0),
    suppressed: Number(r?.suppressed ?? 0),
    status: (r?.job_status as LinkedInImportJobRow["status"]) ?? "running",
    nextCursorRow: Number(r?.next_cursor_row ?? input.nextCursorRow),
  };
}

export async function markImportJobFailed(input: { workspaceId: string; jobId: string; message: string; db?: Db }): Promise<void> {
  const { error } = await client(input.db).rpc("linkedin_fail_import_job", {
    p_workspace_id: input.workspaceId,
    p_job_id: input.jobId,
    p_message: input.message,
  });
  if (error) throw fromPostgres(error, "Could not record the import failure.");
}

export async function getImportJob(input: { workspaceId: string; jobId: string; db?: Db }): Promise<LinkedInImportJobRow | null> {
  const { data, error } = await client(input.db)
    .from("linkedin_import_jobs")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.jobId)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Could not read the import job.");
  return (data as unknown as LinkedInImportJobRow) ?? null;
}

export async function listImportJobs(input: { workspaceId: string; leadListId?: string | null; db?: Db }): Promise<LinkedInImportJobRow[]> {
  let q = client(input.db).from("linkedin_import_jobs").select("*").eq("workspace_id", input.workspaceId);
  if (input.leadListId) q = q.eq("lead_list_id", input.leadListId);
  const { data, error } = await q.order("created_at", { ascending: false }).order("id", { ascending: true }).limit(50);
  if (error) throw fromPostgres(error, "Could not list imports.");
  return (data ?? []) as unknown as LinkedInImportJobRow[];
}

// =====================================================================
// Compliance events
// =====================================================================

export async function recordComplianceEvent(input: {
  workspaceId: string;
  eventType: LinkedInComplianceEventType;
  actorUserId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  details?: Record<string, unknown>;
  db?: Db;
}): Promise<void> {
  const { error } = await client(input.db).from("linkedin_compliance_events").insert({
    workspace_id: input.workspaceId,
    event_type: input.eventType,
    actor_user_id: input.actorUserId ?? null,
    entity_type: input.entityType ?? null,
    entity_id: input.entityId ?? null,
    details: input.details ?? {},
  } as never);
  if (error) throw fromPostgres(error, "Could not record the compliance event.");
}

export interface EventCursor { createdAt: string; id: string }

export async function listComplianceEventsKeyset(input: {
  workspaceId: string;
  before?: EventCursor | null;
  pageSize?: number;
  db?: Db;
}): Promise<{ rows: LinkedInComplianceEventRow[]; nextCursor: EventCursor | null }> {
  const pageSize = Math.min(Math.max(input.pageSize ?? EVENT_PAGE_SIZE, 1), 200);
  let q = client(input.db).from("linkedin_compliance_events").select("*").eq("workspace_id", input.workspaceId);
  if (input.before) {
    q = q.or(`created_at.lt.${input.before.createdAt},and(created_at.eq.${input.before.createdAt},id.lt.${input.before.id})`);
  }
  const { data, error } = await q.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(pageSize + 1);
  if (error) throw fromPostgres(error, "Could not list compliance events.");
  const rows = (data ?? []) as unknown as LinkedInComplianceEventRow[];
  const page = rows.slice(0, pageSize);
  const last = page[page.length - 1];
  return { rows: page, nextCursor: rows.length > pageSize && last ? { createdAt: last.created_at, id: last.id } : null };
}

// =====================================================================
// Scheduler (service role)
// =====================================================================

export async function listActiveCampaignsForDispatch(input: { db: SupabaseClient; limit?: number }): Promise<LinkedInCampaignRow[]> {
  const { data, error } = await input.db
    .from("linkedin_campaigns")
    .select("*")
    .eq("status", "active")
    .order("last_dispatched_at", { ascending: true, nullsFirst: true })
    .order("id", { ascending: true })
    .limit(Math.min(Math.max(input.limit ?? 50, 1), 200));
  if (error) throw fromPostgres(error, "Could not list active campaigns.");
  return (data ?? []) as unknown as LinkedInCampaignRow[];
}

export async function touchCampaignDispatched(input: { workspaceId: string; campaignId: string; nowIso: string; db: SupabaseClient }): Promise<void> {
  const { error } = await input.db
    .from("linkedin_campaigns")
    .update({ last_dispatched_at: input.nowIso } as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.campaignId);
  if (error) throw fromPostgres(error, "Could not record dispatch order.");
}

export async function countTasksReleasedOn(input: { workspaceId: string; campaignId: string; localDate: string; db: SupabaseClient }): Promise<number> {
  const { count, error } = await input.db
    .from("linkedin_manual_tasks")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", input.workspaceId)
    .eq("campaign_id", input.campaignId)
    .eq("local_date", input.localDate);
  if (error) throw fromPostgres(error, "Could not count today's tasks.");
  return count ?? 0;
}

export interface ReleaseOutcome {
  released: number;
  waitsAdvanced: number;
  suppressed: number;
  invalid: number;
  completedMembers: number;
  campaignCompleted: boolean;
}

export async function releaseCampaignTasks(input: {
  workspaceId: string;
  campaignId: string;
  localDate: string;
  nowIso: string;
  limit: number;
  db: SupabaseClient;
}): Promise<ReleaseOutcome> {
  const { data, error } = await input.db.rpc("release_linkedin_campaign_tasks", {
    p_workspace_id: input.workspaceId,
    p_campaign_id: input.campaignId,
    p_local_date: input.localDate,
    p_now: input.nowIso,
    p_limit: input.limit,
  });
  if (error) throw fromPostgres(error, "Could not prepare tasks.");
  const r = (Array.isArray(data) ? data[0] : data) as Record<string, number | boolean>;
  return {
    released: Number(r?.released ?? 0),
    waitsAdvanced: Number(r?.waits_advanced ?? 0),
    suppressed: Number(r?.suppressed ?? 0),
    invalid: Number(r?.invalid ?? 0),
    completedMembers: Number(r?.completed_members ?? 0),
    campaignCompleted: Boolean(r?.campaign_completed),
  };
}
