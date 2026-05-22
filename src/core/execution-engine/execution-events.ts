/**
 * Vocabulary for execution_logs.event_type and activity_events.
 *
 * Keeping these as a typed enum makes it easier to grep across the
 * codebase and surfaces typos at compile time.
 */

export const EXECUTION_LOG_EVENTS = [
  "queue.created",
  "queue.ready",
  "queue.paused",
  "queue.resumed",
  "queue.cancelled",
  "queue.completed",
  "queue.failed",
  "item.queued",
  "item.authorization_requested",
  "item.authorization_allowed",
  "item.authorization_denied",
  "item.scheduled",
  "item.ready",
  "item.dry_run_started",
  "item.dry_run_finished",
  "item.completed",
  "item.blocked",
  "item.backlogged",
  "item.skipped",
  "item.paused",
  "item.resumed",
  "item.failed",
  "item.cancelled",
  "item.retry_scheduled",
] as const;
export type ExecutionLogEvent = (typeof EXECUTION_LOG_EVENTS)[number];

/**
 * Activity event types written to public.activity_events when the
 * corresponding execution event happens. Not every log event is
 * mirrored — we keep the activity stream calm and only surface the
 * operator-relevant ones.
 */
export const EXECUTION_ACTIVITY_EVENTS = [
  "execution_queue.created",
  "execution_queue.paused",
  "execution_queue.resumed",
  "execution_queue.cancelled",
  "execution_queue.completed",
  "execution_item.queued",
  "execution_item.authorized",
  "execution_item.blocked",
  "execution_item.backlogged",
  "execution_item.dry_run_completed",
  "execution_item.failed",
] as const;
export type ExecutionActivityEvent = (typeof EXECUTION_ACTIVITY_EVENTS)[number];
