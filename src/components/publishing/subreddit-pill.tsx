/**
 * Visual subreddit pill with whitelist awareness.
 *
 * Pure component — accepts the allow-list as a prop so it can render
 * in either a server or a client tree. The caller (a server component)
 * resolves the workspace's ALLOWED_TEST_SUBREDDITS and forwards the
 * list down. Don't reach for the env from here: this file ends up in
 * client bundles via the weekly-plan card.
 */

export interface SubredditPillProps {
  subreddit: string | null;
  /** Lowercased subreddit names without /r/ prefix. */
  allowedList?: string[];
}

export function SubredditPill({
  subreddit,
  allowedList = [],
}: SubredditPillProps) {
  if (!subreddit) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-ink-300 px-2 py-0.5 text-[11px] text-ink-500">
        no subreddit
      </span>
    );
  }
  const normalized = subreddit.trim().replace(/^\/?r\//i, "").toLowerCase();
  const isAllowed = allowedList.includes(normalized);

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
        isAllowed
          ? "bg-emerald-50 border-emerald-100 text-emerald-700"
          : "bg-amber-50 border-amber-100 text-amber-700"
      }`}
      title={
        isAllowed
          ? "Allowed test subreddit"
          : "Not yet approved for safe publishing — add to ALLOWED_TEST_SUBREDDITS before approving"
      }
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${
          isAllowed ? "bg-emerald-500" : "bg-amber-500"
        }`}
        aria-hidden
      />
      r/{normalized}
    </span>
  );
}
