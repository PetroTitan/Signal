/**
 * Phase F2.5 — controlled-publish env.
 *
 * Two server-only env vars gate the entire live-publish surface:
 *
 *   SAFE_TEST_MODE=true             enables the controlled path.
 *   ALLOWED_TEST_SUBREDDITS=...     comma- or newline-separated list
 *                                   of subreddit names (no /r/).
 *
 * Default-off: when SAFE_TEST_MODE is unset or anything other than
 * 'true', the controlled-publish path refuses with a structured
 * reason. There is no NEXT_PUBLIC_ exposure of either var.
 */

import "server-only";

export function safeTestModeEnabled(): boolean {
  return (process.env.SAFE_TEST_MODE ?? "").trim().toLowerCase() === "true";
}

/**
 * Returns the allow-listed subreddits in lowercase, with leading /r/
 * stripped. Whitespace tolerant; safe to call when the env is unset
 * (returns []).
 */
export function readAllowedTestSubreddits(): string[] {
  const raw = process.env.ALLOWED_TEST_SUBREDDITS;
  if (!raw) return [];
  return raw
    .split(/[,\n]+/)
    .map((s) => s.trim().replace(/^\/?r\//i, "").toLowerCase())
    .filter((s) => s.length > 0);
}

export function isSubredditAllowed(subreddit: string | null | undefined): boolean {
  if (!subreddit) return false;
  const list = readAllowedTestSubreddits();
  return list.includes(subreddit.trim().replace(/^\/?r\//i, "").toLowerCase());
}

/**
 * Explicit opt-in for AUTONOMOUS Reddit publishing from the scheduler
 * tick.
 *
 * Why this exists
 * --------------
 * Until the routing target was threaded from the plan item to the
 * execution item, every scheduled Reddit item died at
 * `missing_subreddit` before any provider call. The autonomous path
 * was dead, so no gate was needed. Fixing the data defect revives that
 * path — and it revives it into a place with none of the manual
 * path's protections: the tick consults no subreddit allowlist, no
 * 1/hour or 3/day rate limit, no 30-day duplicate fingerprint, and no
 * typed confirmation phrase.
 *
 * Worse, the scope is already latent. `oauth-provider.ts` requests the
 * Reddit `submit` scope only while SAFE_TEST_MODE is true at connect
 * time, and the grant is frozen into the token. A workspace that
 * connected under SAFE_TEST_MODE and later turned it off holds a
 * submit-capable token, so threading the target alone would mean a
 * real Reddit post on the next five-minute cron with no operator in
 * the loop.
 *
 * So autonomous Reddit publishing is opt-in, default off, mirroring
 * the DEVTO_LEGACY_FALLBACK / HASHNODE_LEGACY_FALLBACK /
 * BLUESKY_LEGACY_FALLBACK pattern the runner already uses for
 * credential fallbacks. Unset behaves exactly as production behaves
 * today: no autonomous Reddit provider call.
 */
export function redditAutonomousPublishEnabled(): boolean {
  return (
    (process.env.REDDIT_AUTONOMOUS_PUBLISH ?? "").trim().toLowerCase() ===
    "true"
  );
}

/**
 * The exact confirmation phrase the operator must type into the
 * preview form before the Publish button arms. Lowercase, whitespace
 * collapsed; we compare case-insensitively.
 */
export const PUBLISH_CONFIRMATION_PHRASE = "publish live reddit post";

export function matchesConfirmationPhrase(input: string | null): boolean {
  if (typeof input !== "string") return false;
  const normalized = input.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized === PUBLISH_CONFIRMATION_PHRASE;
}
