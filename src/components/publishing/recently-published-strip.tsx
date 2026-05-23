/**
 * Phase F2.9.7 — small calm strip of recent successful publishes.
 *
 * Pure server component. Renders nothing when there are no recent
 * publishes — the empty state on the parent page already covers the
 * "nothing happened yet" feeling.
 */

export interface RecentlyPublishedEntry {
  id: string;
  title: string | null;
  platform: string;
  subreddit: string | null;
  permalink: string | null;
  publishedAt: string;
  creativeAssetUrl: string | null;
}

export function RecentlyPublishedStrip({
  entries,
}: {
  entries: RecentlyPublishedEntry[];
}) {
  if (entries.length === 0) return null;
  return (
    <section className="rounded-2xl border border-emerald-100 bg-emerald-50/40 p-4">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-sm font-semibold text-ink-900">
          Recently published
        </h2>
        <span className="text-[11px] text-ink-500">
          {entries.length} post{entries.length === 1 ? "" : "s"}
        </span>
      </div>
      <ul className="space-y-2">
        {entries.map((e) => (
          <li
            key={e.id}
            className="flex items-start gap-3 rounded-md bg-white border border-emerald-100 px-3 py-2"
          >
            {e.creativeAssetUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={e.creativeAssetUrl}
                alt=""
                className="w-10 h-10 rounded-md object-cover shrink-0"
              />
            ) : (
              <div className="w-10 h-10 rounded-md bg-emerald-100 grid place-items-center shrink-0 text-emerald-700 text-[10px] font-semibold">
                {e.platform === "reddit" ? "r/" : e.platform.slice(0, 2)}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-ink-900 truncate">
                {e.title ?? "Untitled"}
              </div>
              <div className="text-[11px] text-ink-500 truncate">
                {e.subreddit ? (
                  <span className="font-mono">r/{e.subreddit}</span>
                ) : (
                  e.platform
                )}{" "}
                · {formatRelative(e.publishedAt)}
              </div>
            </div>
            {e.permalink ? (
              <a
                href={e.permalink}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-emerald-700 underline shrink-0"
              >
                Open ↗
              </a>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const ms = Date.now() - d.getTime();
  const minutes = ms / (60 * 1000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const days = hours / 24;
  if (days < 14) return `${Math.round(days)}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
