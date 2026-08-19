/**
 * Publication method — how a post reached the platform (PURE).
 *
 * `publish_history.mode` was a two-value field ('api' | 'manual') and the
 * Results page branched on it as a boolean: `mode === "manual" ? "manual"
 * : "auto"`. Widening the column without fixing that branch would make
 * every 'external' row claim Signal published it — the UI asserting
 * something false about provenance, which is exactly the class of bug
 * this milestone exists to remove.
 *
 * So the mapping lives here, exhaustively, and every surface uses it.
 *
 * Pure module — no I/O.
 */

import type { PublishHistoryMode } from "@/lib/supabase/types";

export const PUBLICATION_METHODS: PublishHistoryMode[] = [
  "api",
  "manual",
  "external",
  "unknown",
];

/**
 * Short label for a dense list row. Deliberately neutral: "external" is
 * not worse than "auto", it is a different provenance.
 */
export function publicationMethodLabel(mode: string): string {
  switch (mode) {
    case "api":
      return "auto";
    case "manual":
      return "manual";
    case "external":
      return "published outside Signal";
    case "unknown":
      return "source unknown";
    default:
      // A value the app does not recognise must NOT fall back to "auto".
      // Claiming Signal published something it did not is the one wrong
      // answer here.
      return "source unknown";
  }
}

/** Longer explanation, for tooltips and the account-health surface. */
export function publicationMethodDescription(mode: string): string {
  switch (mode) {
    case "api":
      return "Signal published this through the provider's API.";
    case "manual":
      return "A person published this and recorded it in Signal.";
    case "external":
      return (
        "Found on the provider. Signal did not publish it and does not know " +
        "how it was composed."
      );
    case "unknown":
      return "How this reached the platform was not recorded.";
    default:
      return "How this reached the platform was not recorded.";
  }
}

/**
 * The comparison group a post belongs to.
 *
 * `signal_api` vs `not_signal_api` is the only split the data can
 * support: 'manual' and 'external' differ in how Signal LEARNED about
 * the post, not in how it reached the platform, and both are "a human
 * posted this natively".
 */
export type PublicationGroup = "signal_api" | "human_published" | "unknown";

export function publicationGroup(mode: string): PublicationGroup {
  switch (mode) {
    case "api":
      return "signal_api";
    case "manual":
    case "external":
      return "human_published";
    default:
      return "unknown";
  }
}

export function publicationGroupLabel(group: PublicationGroup): string {
  switch (group) {
    case "signal_api":
      return "Published by Signal";
    case "human_published":
      return "Published by a person";
    default:
      return "Attribution unknown";
  }
}

/** True for a value the schema permits. Used when ingesting. */
export function isPublicationMethod(value: unknown): value is PublishHistoryMode {
  return (
    typeof value === "string" &&
    (PUBLICATION_METHODS as string[]).includes(value)
  );
}
