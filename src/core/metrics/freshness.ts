/**
 * Data freshness (PURE).
 *
 * "Do not silently present stale metrics as live." Every provider value
 * Signal shows carries when it was fetched and what that means now, so a
 * number from three weeks ago reads as three weeks old rather than as
 * the current state of the world.
 *
 * Freshness is derived from the reading's own age, not from the post's:
 * a 6-month-old post read an hour ago has fresh metrics.
 *
 * Pure module — no I/O, no clock.
 */

import type { MetricFreshness } from "@/lib/supabase/types";

export type Freshness = MetricFreshness;

/**
 * A cached reading is considered current for this long. Matched to the
 * sweep's 6-hour connected-refresh cooldown: anything older than a
 * couple of sweep cycles has had a chance to be refreshed and wasn't.
 */
export const FRESH_MAX_AGE_HOURS = 12;

export interface FreshnessInput {
  /** When the value was read from the provider. */
  fetchedAtIso: string | null | undefined;
  nowIso: string;
  /** Did the last read actually return counts? */
  status: "connected" | "unavailable" | "unsupported" | "pending";
  rateLimited?: boolean;
  /** Set when the last read failed for a provider-side reason. */
  providerError?: boolean;
}

/**
 * Classify a cached reading.
 *
 * Order matters: a rate-limited or errored read is reported as such even
 * if a previous good value is still cached, because the operator needs
 * to know the number in front of them is not being updated.
 */
export function classifyFreshness(input: FreshnessInput): Freshness {
  if (input.rateLimited) return "rate_limited";
  if (input.providerError) return "provider_error";
  if (input.status === "unsupported" || input.status === "unavailable") {
    return "unavailable";
  }
  if (input.status === "pending" || !input.fetchedAtIso) return "unavailable";

  const fetched = Date.parse(input.fetchedAtIso);
  const now = Date.parse(input.nowIso);
  if (!Number.isFinite(fetched) || !Number.isFinite(now)) return "unavailable";

  const ageHours = (now - fetched) / 3_600_000;
  // A future fetched_at means clock disagreement, not freshness.
  if (ageHours < 0) return "stale";
  return ageHours <= FRESH_MAX_AGE_HOURS ? "fresh" : "stale";
}

/** Hours since the reading, or null when it was never read. */
export function readingAgeHours(
  fetchedAtIso: string | null | undefined,
  nowIso: string,
): number | null {
  if (!fetchedAtIso) return null;
  const fetched = Date.parse(fetchedAtIso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(fetched) || !Number.isFinite(now)) return null;
  return Math.round(((now - fetched) / 3_600_000) * 100) / 100;
}

/**
 * Operator-facing wording. Never says "live" or "current" for anything
 * that is not fresh, and always attaches an age to a stale value.
 */
export function describeFreshness(
  freshness: Freshness,
  ageHours: number | null,
): string {
  switch (freshness) {
    case "fresh":
      return ageHours == null
        ? "Measured recently."
        : `Measured ${formatAge(ageHours)} ago.`;
    case "stale":
      return ageHours == null
        ? "Last measurement is out of date."
        : `Last measured ${formatAge(ageHours)} ago — not refreshed since.`;
    case "rate_limited":
      return "The provider rate-limited the last refresh; this value is not being updated.";
    case "provider_error":
      return "The last refresh failed against the provider; this value is not being updated.";
    default:
      return "No measurement is available.";
  }
}

/** True when a value may be presented without a staleness caveat. */
export function isPresentableAsCurrent(freshness: Freshness): boolean {
  return freshness === "fresh";
}

export function formatAge(hours: number): string {
  if (hours < 1) {
    const minutes = Math.max(1, Math.round(hours * 60));
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  if (hours < 48) {
    const h = Math.round(hours);
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * Confidence in a reading: did the provider return everything this
 * platform is documented to support?
 *
 * `partial` matters because X returns all six public_metrics together —
 * a response missing some of them signals a shape change worth noticing,
 * not a post with no bookmarks.
 */
export function classifyConfidence(
  supportedMetrics: readonly string[],
  returnedMetrics: Record<string, unknown>,
): "verified" | "partial" | "unknown" {
  if (supportedMetrics.length === 0) return "unknown";
  const present = supportedMetrics.filter(
    (key) => typeof returnedMetrics[key] === "number",
  );
  if (present.length === 0) return "unknown";
  return present.length === supportedMetrics.length ? "verified" : "partial";
}
