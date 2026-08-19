/**
 * Account-level context — the numbers that make post performance
 * interpretable (PURE).
 *
 * The Phase 0 audit found the primary Bluesky identity has ONE follower.
 * Every post it published sits at zero or one interaction, and reading
 * that as an algorithmic problem would be a mistake: an account with no
 * audience has no distribution to lose. Follower count is therefore not
 * a decoration on a performance screen — it is the denominator without
 * which every other number is uninterpretable.
 *
 * This module is deliberately NOT a score. It reports what the provider
 * said and classifies audience size into bands whose only purpose is to
 * gate interpretation: below a threshold, Signal must decline to draw
 * performance conclusions at all rather than dress up noise.
 *
 * Pure module — no I/O, no clock.
 */

export interface AccountSnapshot {
  platform: string;
  /** Provider handle, e.g. "webmasterid.bsky.social" or "Webmasteridcore". */
  handle: string;
  /** Stable provider id (DID for Bluesky, numeric id for X). */
  providerAccountId: string | null;
  followers: number | null;
  following: number | null;
  /** Total posts the provider reports on the account, not what Signal published. */
  postCount: number | null;
  /** Account creation instant, when the provider exposes it. */
  createdAt: string | null;
  fetchedAt: string;
  source: string;
}

/**
 * Audience bands. The thresholds are interpretation gates, not quality
 * judgements, and the labels are deliberately flat — no "dead", no
 * "failing", no emoji. An account with 1 follower is not a bad account;
 * it is an account whose reach cannot be measured.
 */
export type AudienceBand =
  | "no_audience"
  | "minimal_audience"
  | "small_audience"
  | "established_audience"
  | "unknown";

/** Below this, engagement is dominated by chance and off-network views. */
export const MINIMAL_AUDIENCE_CEILING = 25;
/** Below this, a single external share swamps any organic pattern. */
export const SMALL_AUDIENCE_CEILING = 500;

export function audienceBand(followers: number | null | undefined): AudienceBand {
  if (followers == null || !Number.isFinite(followers)) return "unknown";
  if (followers <= 1) return "no_audience";
  if (followers < MINIMAL_AUDIENCE_CEILING) return "minimal_audience";
  if (followers < SMALL_AUDIENCE_CEILING) return "small_audience";
  return "established_audience";
}

/**
 * Whether performance comparisons on this account mean anything at all.
 *
 * This is the guard that stops Signal telling an operator their reach
 * "declined" when the account never had reach to begin with.
 */
export function audienceSupportsPerformanceAnalysis(
  followers: number | null | undefined,
): boolean {
  const band = audienceBand(followers);
  return band === "small_audience" || band === "established_audience";
}

export function describeAudience(snapshot: {
  platform: string;
  followers: number | null;
}): string {
  const { followers } = snapshot;
  if (followers == null) {
    return "Follower count unavailable, so performance cannot be put in context.";
  }
  switch (audienceBand(followers)) {
    case "no_audience":
      return (
        `${followers} follower${followers === 1 ? "" : "s"}. With effectively no ` +
        "audience, near-zero engagement is the expected outcome and says nothing " +
        "about how the platform is treating this account."
      );
    case "minimal_audience":
      return (
        `${followers} followers. Too small for engagement to carry signal — ` +
        "individual results here are dominated by chance."
      );
    case "small_audience":
      return (
        `${followers} followers. Large enough to see patterns, small enough that ` +
        "one external share can swamp them."
      );
    case "established_audience":
      return `${followers} followers.`;
    default:
      return "Follower count unavailable.";
  }
}

/** Follower change between two snapshots, when both are known. */
export function followerDelta(
  earlier: Pick<AccountSnapshot, "followers"> | null,
  later: Pick<AccountSnapshot, "followers"> | null,
): number | null {
  if (
    !earlier ||
    !later ||
    earlier.followers == null ||
    later.followers == null
  ) {
    return null;
  }
  return later.followers - earlier.followers;
}
