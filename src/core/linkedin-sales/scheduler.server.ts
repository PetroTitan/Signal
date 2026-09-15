import "server-only";
/**
 * The LinkedIn Sales scheduler: it PREPARES manual tasks. Nothing else.
 *
 * Every few minutes a cron calls one round. The round looks at each
 * active campaign in fairness order, asks whether the campaign's local
 * working window is open and how much of today's task target is left,
 * and then asks PostgreSQL to release that many tasks for members whose
 * next step is due. The release is one transaction per campaign
 * (`release_linkedin_campaign_tasks`), guarded by the one-active-task
 * index and the (member, step) uniqueness, so a replayed or overlapping
 * round cannot create a second task for the same step.
 *
 * WHAT IT DOES NOT DO — BY CONSTRUCTION, NOT BY POLICY
 *   It never opens a profile, sends a message, requests a connection,
 *   or marks a task done. This module imports no operator function
 *   (confirm, skip, opened, copied), and the database grants the
 *   service role no right to call them. A test checks both.
 *
 * THE DAILY TARGET
 *   `daily_task_target` bounds how many tasks Signal prepares for the
 *   operator per local calendar day. It is a workload setting for the
 *   person doing the work. It is not, and must never be described as,
 *   a "safe" limit for LinkedIn activity — LinkedIn publishes no such
 *   number, and the operator's own conduct on LinkedIn is theirs.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { isValidTimezone, isWithinWindow, localClockAt } from "@/core/bluesky-campaigns/campaign-day";
import type { LinkedInCampaignRow } from "@/lib/supabase/types";
import {
  countTasksReleasedOn,
  listActiveCampaignsForDispatch,
  releaseCampaignTasks,
  touchCampaignDispatched,
} from "@/repositories/linkedin-sales-repository";

export const DEFAULT_TICK_DEADLINE_MS = 55_000;
export const MAX_TICK_DEADLINE_MS = 240_000;
/** Time we reserve per campaign before deciding not to start another. */
export const PER_CAMPAIGN_ALLOWANCE_MS = 3_000;

export function tickDeadlineMs(env: Record<string, string | undefined>): number {
  const raw = Number(env.LINKEDIN_TICK_DEADLINE_MS);
  if (!Number.isFinite(raw) || raw < 10_000) return DEFAULT_TICK_DEADLINE_MS;
  return Math.min(Math.floor(raw), MAX_TICK_DEADLINE_MS);
}

/** Deploy-level switch: when set, no round considers any campaign. */
export function isLinkedInSchedulerDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.LINKEDIN_SALES_DISABLED ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Round order: never served first, then least recently served, then id
 * so the order is total and reproducible. Exported so a mutation that
 * removes fairness fails a test rather than a production day.
 */
export function orderCampaignsFairly<T extends Pick<LinkedInCampaignRow, "id" | "last_dispatched_at">>(campaigns: T[]): T[] {
  const stamp = (c: T): number | null => {
    if (!c.last_dispatched_at) return null;
    const t = Date.parse(c.last_dispatched_at);
    return Number.isNaN(t) ? null : t;
  };
  return [...campaigns].sort((a, b) => {
    const x = stamp(a);
    const y = stamp(b);
    if (x !== y) {
      if (x === null) return -1;
      if (y === null) return 1;
      return x < y ? -1 : 1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export type DeferReason = "deadline" | "outside_window" | "invalid_timezone" | "daily_target_reached";

export interface CampaignOutcome {
  campaignId: string;
  workspaceId: string;
  localDate: string;
  budget: number;
  released: number;
  waitsAdvanced: number;
  suppressed: number;
  invalid: number;
  completedMembers: number;
  campaignCompleted: boolean;
}

export interface PrepareRoundResult {
  deadlineMs: number;
  considered: number;
  served: CampaignOutcome[];
  deferred: { campaignId: string; reason: DeferReason }[];
  /** Always present so no reader can mistake this for provider activity. */
  note: string;
}

export const ROUND_NOTE = "Signal prepared internal manual tasks. No LinkedIn action was performed.";

export interface PrepareRoundInput {
  db: SupabaseClient;
  /** The instant of this round. Injected so days and windows are testable. */
  now?: Date;
  deadlineMs?: number;
}

export async function prepareManualTasks(input: PrepareRoundInput): Promise<PrepareRoundResult> {
  const now = input.now ?? new Date();
  const deadline = input.deadlineMs ?? DEFAULT_TICK_DEADLINE_MS;
  const startedAt = performance.now();
  const remaining = () => deadline - (performance.now() - startedAt);

  const result: PrepareRoundResult = { deadlineMs: deadline, considered: 0, served: [], deferred: [], note: ROUND_NOTE };
  const campaigns = orderCampaignsFairly(await listActiveCampaignsForDispatch({ db: input.db }));
  result.considered = campaigns.length;

  for (let i = 0; i < campaigns.length; i += 1) {
    const campaign = campaigns[i];
    if (remaining() < PER_CAMPAIGN_ALLOWANCE_MS) {
      for (const rest of campaigns.slice(i)) result.deferred.push({ campaignId: rest.id, reason: "deadline" });
      break;
    }
    if (!isValidTimezone(campaign.timezone)) {
      result.deferred.push({ campaignId: campaign.id, reason: "invalid_timezone" });
      continue;
    }
    const clock = localClockAt(now, campaign.timezone);
    const inWindow = isWithinWindow(now, campaign.timezone, {
      startMinute: campaign.working_window_start_minute,
      endMinute: campaign.working_window_end_minute,
    });
    if (!inWindow) {
      result.deferred.push({ campaignId: campaign.id, reason: "outside_window" });
      continue;
    }

    // Persist the rotation BEFORE the work: a round killed mid-release
    // has already moved this campaign behind the others.
    await touchCampaignDispatched({ workspaceId: campaign.workspace_id, campaignId: campaign.id, nowIso: now.toISOString(), db: input.db });

    const preparedToday = await countTasksReleasedOn({
      workspaceId: campaign.workspace_id, campaignId: campaign.id, localDate: clock.localDate, db: input.db,
    });
    const budget = campaign.daily_task_target - preparedToday;
    if (budget <= 0) {
      result.deferred.push({ campaignId: campaign.id, reason: "daily_target_reached" });
      continue;
    }

    const r = await releaseCampaignTasks({
      workspaceId: campaign.workspace_id,
      campaignId: campaign.id,
      localDate: clock.localDate,
      nowIso: now.toISOString(),
      limit: budget,
      db: input.db,
    });
    result.served.push({
      campaignId: campaign.id,
      workspaceId: campaign.workspace_id,
      localDate: clock.localDate,
      budget,
      released: r.released,
      waitsAdvanced: r.waitsAdvanced,
      suppressed: r.suppressed,
      invalid: r.invalid,
      completedMembers: r.completedMembers,
      campaignCompleted: r.campaignCompleted,
    });
  }
  return result;
}
