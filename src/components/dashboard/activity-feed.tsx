/**
 * Compact operator activity feed.
 *
 * Dashboard Organization Pass — Phase 4. Reads the EXISTING
 * `activity_events` audit rows (passed in by the page) and renders a
 * calm, dense feed of recent operator events ("Published to Bluesky",
 * "Creative approved", "Post approved", "Schedule updated", …). No new
 * table, no new writes — purely a read view over source-of-truth audit
 * data.
 *
 * Pure server component. Renders nothing when there are no events so an
 * empty workspace doesn't show a hollow card.
 */

import Link from "next/link";
import {
  describeActivityEvent,
  type ActivityEventLike,
  type ActivityTone,
} from "@/core/dashboard/activity-feed-labels";

const DOT_CLASS: Record<ActivityTone, string> = {
  success: "bg-emerald-500",
  info: "bg-signal-500",
  warn: "bg-amber-500",
  danger: "bg-red-500",
  muted: "bg-ink-300",
};

export interface ActivityFeedItem extends ActivityEventLike {
  id: string;
  createdAt: string;
}

export interface ActivityFeedProps {
  events: ActivityFeedItem[];
  /** Optional "see all" link target (defaults to the Activity page). */
  seeAllHref?: string;
  title?: string;
}

function relativeTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const ms = Date.now() - d.getTime();
  const minutes = ms / 60000;
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const days = hours / 24;
  if (days < 14) return `${Math.round(days)}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function ActivityFeed({
  events,
  seeAllHref = "/activity",
  title = "Activity",
}: ActivityFeedProps) {
  if (events.length === 0) return null;
  return (
    <section className="card overflow-hidden">
      <div className="px-5 py-3.5 border-b border-ink-100 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink-900">{title}</h2>
        <Link
          href={seeAllHref}
          className="text-xs font-medium text-signal-700 hover:text-signal-800"
        >
          See all →
        </Link>
      </div>
      <ul className="row-divider">
        {events.map((e) => {
          const line = describeActivityEvent(e);
          return (
            <li key={e.id} className="px-5 py-2.5 flex items-center gap-3">
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${DOT_CLASS[line.tone]}`}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <span className="text-sm text-ink-800">{line.label}</span>
                {e.title && e.title !== line.label ? (
                  <span className="text-xs text-ink-500 truncate"> · {e.title}</span>
                ) : null}
              </div>
              <time
                dateTime={e.createdAt}
                className="text-[11px] text-ink-400 shrink-0 tabular-nums"
              >
                {relativeTime(e.createdAt)}
              </time>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
