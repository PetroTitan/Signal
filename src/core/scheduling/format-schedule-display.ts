/**
 * One-shot composer that turns (planItem, executionItem?, workspaceTimezone,
 * serverNow) into the fully-rendered prop shape every operator-facing
 * card / detail page needs.
 *
 * Pure module — no React, no I/O. Server components call this at
 * render time; client components receive the result as serialized
 * props. Keeping the composition in one place means every surface
 * shows the same canonical text and the same divergence warning.
 *
 * Out of scope: card chrome, button labels, MCP responses.
 */

import {
  describeEffectiveSource,
  getEffectivePublishSchedule,
  type EffectivePublishSchedule,
  type ExecutionItemForSchedule,
  type PlanItemForSchedule,
} from "./effective-publish-schedule";
import {
  formatUtcForOperatorDebug,
  formatUtcForWorkspace,
  getRelativeDueLabel,
  type DueState,
  type FormattedTime,
  type RelativeDueLabel,
} from "./workspace-time";

export interface ScheduleDisplay {
  /** Effective publish ISO (UTC) or null when nothing scheduled. */
  effectiveScheduledAt: string | null;
  /** "Mon, May 25, 5:33 PM" / null when nothing scheduled. */
  local: string | null;
  /** "2026-05-25 21:33 UTC" / null. */
  utc: string | null;
  /** "America/New_York" or "UTC" — always present so the UI can label
   *  the local string. */
  timezone: string;
  /** "Due in 2h 49m" / "Due now" / "Overdue by 6m" / null. */
  relative: string | null;
  /** Categorical state for chip coloring. null when nothing scheduled. */
  dueState: DueState | null;
  /** Signed seconds (positive = future). null when nothing scheduled. */
  dueInSeconds: number | null;
  /** Where the effective time came from. */
  source: EffectivePublishSchedule["source"];
  /** "Publish trigger: execution item" / "Planning time only" / "No schedule". */
  sourceLabel: string;
  /** True when plan_item and active exec_item disagree (>=1s). */
  isDiverged: boolean;
  /** Operator-facing copy for the divergence warning. null when not diverged. */
  divergenceWarning: string | null;
  /** Full canonical model in case the caller needs the raw fields. */
  schedule: EffectivePublishSchedule;
}

export interface FormatScheduleDisplayInput {
  planItem: PlanItemForSchedule;
  executionItem?: ExecutionItemForSchedule | null;
  /** IANA name. Pass `"UTC"` as the safe default when the workspace
   *  has no timezone configured. */
  workspaceTimezone: string;
  /** Server time used for the relative-due label. Pass the same Date
   *  for every card on a page so the labels are coherent. */
  serverNow: Date;
}

const DIVERGENCE_WARNING =
  "Planning time and publish trigger differ. Click Update publish time to resync.";

/**
 * Compose a fully-rendered display shape from the canonical inputs.
 * Returns predictable null values when no schedule is set so callers
 * can branch on `effectiveScheduledAt === null` without parsing the
 * other fields.
 */
export function formatScheduleDisplay(
  input: FormatScheduleDisplayInput,
): ScheduleDisplay {
  const schedule = getEffectivePublishSchedule(
    input.planItem,
    input.executionItem,
  );
  const sourceLabel = describeEffectiveSource(schedule);
  const divergenceWarning = schedule.isDiverged ? DIVERGENCE_WARNING : null;

  if (schedule.effectiveScheduledAt === null) {
    return {
      effectiveScheduledAt: null,
      local: null,
      utc: null,
      timezone: input.workspaceTimezone,
      relative: null,
      dueState: null,
      dueInSeconds: null,
      source: schedule.source,
      sourceLabel,
      isDiverged: false,
      divergenceWarning: null,
      schedule,
    };
  }

  const formatted: FormattedTime = formatUtcForWorkspace(
    schedule.effectiveScheduledAt,
    input.workspaceTimezone,
  );
  const due: RelativeDueLabel = getRelativeDueLabel(
    schedule.effectiveScheduledAt,
    input.serverNow,
  );

  return {
    effectiveScheduledAt: schedule.effectiveScheduledAt,
    local: formatted.local,
    utc: formatted.utc,
    timezone: formatted.timezone,
    relative: due.relative,
    dueState: due.state,
    dueInSeconds: due.deltaSeconds,
    source: schedule.source,
    sourceLabel,
    isDiverged: schedule.isDiverged,
    divergenceWarning,
    schedule,
  };
}

/**
 * Convenience accessor — operator-debug UTC string for a raw ISO,
 * no workspace zone needed. Useful in logs and admin pages.
 */
export function formatScheduleDebugUtc(utcIso: string | null): string | null {
  if (utcIso === null) return null;
  return formatUtcForOperatorDebug(utcIso);
}
