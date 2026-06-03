/**
 * Pure mapper: activity_events.event_type → compact operator-feed line.
 *
 * Dashboard Organization Pass — Phase 4. The activity feed reads the
 * EXISTING `activity_events` audit table (no new table, no new writes)
 * and turns the technical event_type slugs into a calm one-line
 * operator summary plus a tone for the dot.
 *
 * Pure module — no React, no I/O. Unknown event types fall back to the
 * event's own human title, so a newly-added event type still renders
 * something sensible without a code change here.
 */

export type ActivityTone = "success" | "info" | "warn" | "danger" | "muted";

export interface ActivityLine {
  /** Short operator-facing summary, e.g. "Published to Bluesky". */
  label: string;
  tone: ActivityTone;
}

export interface ActivityEventLike {
  eventType: string;
  title: string;
  metadata: Record<string, unknown>;
}

function platformLabel(metadata: Record<string, unknown>): string | null {
  const raw =
    (typeof metadata.platform === "string" && metadata.platform) ||
    (typeof metadata.target_platform === "string" && metadata.target_platform) ||
    null;
  if (!raw) return null;
  const map: Record<string, string> = {
    reddit: "Reddit",
    x: "X",
    linkedin: "LinkedIn",
    devto: "dev.to",
    hashnode: "Hashnode",
    bluesky: "Bluesky",
    telegram: "Telegram",
    instagram: "Instagram",
    youtube: "YouTube",
  };
  return map[raw] ?? raw;
}

/**
 * Static event_type → (summary, tone). Keep these grounded in the
 * REAL event types recorded across the app (see recordActivity call
 * sites). Publish events accept an optional platform suffix.
 */
const STATIC_LINES: Record<string, ActivityLine> = {
  "reddit.post_published": { label: "Published to Reddit", tone: "success" },
  "item.completed": { label: "Published", tone: "success" },
  "manual_publish.recorded": { label: "Manual publish recorded", tone: "success" },
  "item.scheduled": { label: "Schedule updated", tone: "info" },
  "weekly_plan_item.scheduled": { label: "Post scheduled", tone: "info" },
  "weekly_plan_item.schedule_changed": { label: "Schedule updated", tone: "info" },
  "item.schedule_resynced": { label: "Schedule re-synced", tone: "info" },
  "mcp.publish_scheduled": { label: "Publish scheduled", tone: "info" },
  "mcp.publish_rescheduled": { label: "Publish rescheduled", tone: "info" },
  "weekly_plan_item.approved_and_scheduled": {
    label: "Post approved & scheduled",
    tone: "success",
  },
  "weekly_plan_item.approved_and_held": {
    label: "Post approved & held",
    tone: "success",
  },
  "plan.approved_and_held": { label: "Plan approved & held", tone: "success" },
  "weekly_plan.approved": { label: "Weekly plan approved", tone: "success" },
  "weekly_plan_item.approved": { label: "Post approved", tone: "success" },
  "weekly_plan_item.creative_approved": { label: "Creative approved", tone: "success" },
  "weekly_plan_item.approval_cancelled": {
    label: "Approval cancelled",
    tone: "warn",
  },
  "weekly_plan_item.sent_for_approval": {
    label: "Sent for approval",
    tone: "info",
  },
  "weekly_plan_item.created": { label: "Post created", tone: "muted" },
  "weekly_plan_item.removed": { label: "Post removed", tone: "muted" },
  "draft.generated": { label: "Draft generated", tone: "muted" },
  "draft.rewritten": { label: "Draft rewritten", tone: "muted" },
  "draft.rewrite_undone": { label: "Draft rewrite undone", tone: "muted" },
  "item.failed": { label: "Publish failed", tone: "danger" },
  "item.blocked": { label: "Publish blocked", tone: "danger" },
  "execution_item.blocked": { label: "Publish blocked", tone: "danger" },
  "item.skipped": { label: "Publish skipped", tone: "warn" },
  "item.backlogged": { label: "Moved to backlog", tone: "muted" },
  "item.ready_for_manual_publish": {
    label: "Ready for manual publish",
    tone: "info",
  },
};

// Event types whose label reads better with a "to <Platform>" suffix.
const PLATFORM_SUFFIX_EVENTS = new Set<string>([
  "item.completed",
  "manual_publish.recorded",
]);

export function describeActivityEvent(event: ActivityEventLike): ActivityLine {
  const base = STATIC_LINES[event.eventType];
  if (!base) {
    // Unknown event type — fall back to its own human title.
    return { label: event.title, tone: "muted" };
  }
  if (PLATFORM_SUFFIX_EVENTS.has(event.eventType)) {
    const platform = platformLabel(event.metadata);
    if (platform) {
      return { label: `Published to ${platform}`, tone: base.tone };
    }
  }
  return base;
}
