/**
 * Truthful empty states (PURE).
 *
 * "No data" is eight different situations wearing one label, and each of
 * them implies a different operator action:
 *
 *   nothing has been published            publish something
 *   measurement has never run             check the cron
 *   the provider does not expose this     nothing to do, ever
 *   the value is stale                    check why refresh stopped
 *   the provider errored                  check the provider
 *   the post is too old for this metric   nothing to do, ever
 *   too little data for analysis          keep publishing
 *   the backfill has not been run         run the backfill
 *
 * Collapsing them loses the action. This module is the single vocabulary
 * for that distinction, so a component cannot casually reintroduce a
 * generic message.
 *
 * Pure module — no I/O.
 */

export type EmptyStateKey =
  | "no_publications"
  | "never_measured"
  | "provider_does_not_expose"
  | "stale"
  | "provider_error"
  | "too_old_for_metric"
  | "insufficient_data"
  | "backfill_not_run"
  | "not_yet_due";

export interface EmptyState {
  key: EmptyStateKey;
  /** Short label for a cell or a badge. */
  label: string;
  /** Full sentence for a panel. Always says WHY. */
  message: string;
  /** What clears it, or null when nothing can. */
  action: string | null;
}

/**
 * The generic phrasings this vocabulary exists to prevent. Exported so
 * the regression test can scan rendered output for them rather than
 * relying on review.
 */
export const BANNED_EMPTY_PHRASES = [
  "no data",
  "n/a",
  "nothing to show",
  "no results",
  "--",
] as const;

const STATES: Record<EmptyStateKey, EmptyState> = {
  no_publications: {
    key: "no_publications",
    label: "Nothing published",
    message: "Nothing has been published through Signal yet, so there is nothing to measure.",
    action: "Publish something from the weekly plan.",
  },
  never_measured: {
    key: "never_measured",
    label: "Never measured",
    message:
      "No measurement run has completed yet, so no value here is missing — none has been collected.",
    action: "Check that the refresh job is running, then trigger one run by hand.",
  },
  provider_does_not_expose: {
    key: "provider_does_not_expose",
    label: "Unavailable from this provider",
    message:
      "This platform does not report this metric at all. It is a property of the platform, not a gap in this account's data, and no amount of waiting or refreshing will produce it.",
    action: null,
  },
  stale: {
    key: "stale",
    label: "Stale",
    message:
      "A measurement exists but it has not been refreshed recently enough to present as current.",
    action: "Check why the refresh job stopped updating this.",
  },
  provider_error: {
    key: "provider_error",
    label: "Provider error",
    message:
      "The last read failed against the provider, so this value is not being updated. It is not zero.",
    action: "Check the provider connection and any rate limit or billing state.",
  },
  too_old_for_metric: {
    key: "too_old_for_metric",
    label: "Too old to measure",
    message:
      "This post is past the window in which this measurement could be taken. The reading is unobtainable now, at any price.",
    action: null,
  },
  insufficient_data: {
    key: "insufficient_data",
    label: "Not enough data",
    message:
      "There are too few measured posts to say anything reliable. This is a real answer, not a missing one.",
    action: "Keep publishing; the threshold is a sample size, not a setting.",
  },
  backfill_not_run: {
    key: "backfill_not_run",
    label: "Backfill not run",
    message:
      "Publications older than the enrolment window exist and have never been measured. The scheduled sweep will never reach them.",
    action: "Preview a bounded historical backfill, then run it.",
  },
  not_yet_due: {
    key: "not_yet_due",
    label: "Not due yet",
    message:
      "This post is too new for its first measurement window. An absent value here is correct.",
    action: null,
  },
};

export function emptyState(key: EmptyStateKey): EmptyState {
  return STATES[key];
}

export const ALL_EMPTY_STATES: EmptyState[] = Object.values(STATES);

/**
 * Map a coverage verdict onto the right empty state, so the UI never has
 * to make this judgement inline.
 */
export function emptyStateForCoverage(state: string): EmptyState | null {
  switch (state) {
    case "not_yet_due":
      return STATES.not_yet_due;
    case "stale":
      return STATES.stale;
    case "provider_error":
      return STATES.provider_error;
    case "provider_unavailable":
      return STATES.provider_does_not_expose;
    case "outside_recoverable_window":
      return STATES.backfill_not_run;
    case "missing_provider_post_id":
      return STATES.too_old_for_metric;
    default:
      return null;
  }
}

/** True when a string is one of the generic phrasings this replaces. */
export function isBannedEmptyPhrase(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (BANNED_EMPTY_PHRASES as readonly string[]).some(
    (phrase) => normalized === phrase,
  );
}
