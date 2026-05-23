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
