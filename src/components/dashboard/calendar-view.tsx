/**
 * Phase B1 — read-only scheduling calendar (month/week).
 *
 * Pure server component. Renders a pre-built {@link CalendarGrid}
 * (workspace-local day buckets of genuinely-scheduled items). No local
 * state, no drag/drop in this phase — clicking an event opens the
 * existing item detail. The caller excludes published/failed items;
 * this component only renders what it's given.
 */

import Link from "next/link";
import type { CalendarGrid, CalendarMode } from "@/core/dashboard/calendar-grid";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function platformTone(platform: string | null): string {
  switch (platform) {
    case "reddit":
      return "bg-orange-100 text-orange-800";
    case "x":
      return "bg-ink-900 text-white";
    case "bluesky":
      return "bg-sky-100 text-sky-800";
    case "telegram":
      return "bg-sky-100 text-sky-700";
    case "devto":
    case "hashnode":
      return "bg-ink-100 text-ink-700";
    default:
      return "bg-signal-100 text-signal-700";
  }
}

function timeLabel(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: timezone,
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return "";
  }
}

export interface CalendarViewProps {
  grid: CalendarGrid;
  timezone: string;
  /** Path the prev/next/today + mode links point at (e.g. /weekly-plan). */
  basePath: string;
  /** Query params preserved on nav (e.g. { tab: "calendar" }). */
  baseParams: Record<string, string>;
}

function navHref(
  basePath: string,
  baseParams: Record<string, string>,
  overrides: Record<string, string>,
): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(baseParams)) if (v) p.set(k, v);
  for (const [k, v] of Object.entries(overrides)) if (v) p.set(k, v);
  const qs = p.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

export function CalendarView({ grid, timezone, basePath, baseParams }: CalendarViewProps) {
  const otherMode: CalendarMode = grid.mode === "month" ? "week" : "month";
  return (
    <section className="card overflow-hidden">
      {/* Header: range label + prev/today/next + month/week toggle */}
      <div className="px-4 sm:px-5 py-3 border-b border-ink-100 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Link
            href={navHref(basePath, baseParams, { anchor: grid.prevAnchorIso, mode: grid.mode })}
            className="btn text-xs"
            aria-label="Previous"
          >
            ←
          </Link>
          <Link
            href={navHref(basePath, baseParams, { anchor: grid.todayAnchorIso, mode: grid.mode })}
            className="btn text-xs"
          >
            Today
          </Link>
          <Link
            href={navHref(basePath, baseParams, { anchor: grid.nextAnchorIso, mode: grid.mode })}
            className="btn text-xs"
            aria-label="Next"
          >
            →
          </Link>
          <span className="text-sm font-semibold text-ink-900 ml-1">{grid.label}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-ink-500">{timezone}</span>
          <Link
            href={navHref(basePath, baseParams, { anchor: grid.todayAnchorIso, mode: otherMode })}
            className="btn text-xs capitalize"
          >
            {otherMode} view
          </Link>
        </div>
      </div>

      {/* Weekday header */}
      <div className="grid grid-cols-7 border-b border-ink-100 bg-ink-50/50">
        {WEEKDAYS.map((d) => (
          <div key={d} className="px-2 py-1.5 text-[10px] uppercase tracking-wide text-ink-500 font-semibold text-center">
            {d}
          </div>
        ))}
      </div>

      {/* Weeks */}
      <div>
        {grid.weeks.map((week, wi) => (
          <div key={wi} className="grid grid-cols-7 border-b border-ink-100 last:border-b-0">
            {week.map((day) => (
              <div
                key={day.dateKey}
                className={`min-h-[5.5rem] border-r border-ink-100 last:border-r-0 p-1.5 ${
                  day.inFocusMonth ? "bg-white" : "bg-ink-50/40"
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span
                    className={`text-[11px] inline-flex items-center justify-center w-5 h-5 rounded-full ${
                      day.isToday
                        ? "bg-signal-600 text-white font-semibold"
                        : day.inFocusMonth
                          ? "text-ink-700"
                          : "text-ink-400"
                    }`}
                  >
                    {day.day}
                  </span>
                </div>
                <div className="space-y-1">
                  {day.events.slice(0, 4).map((e) => (
                    <Link
                      key={e.id}
                      href={e.href}
                      title={`${e.title ?? "Untitled"} · ${timeLabel(e.scheduledAt, timezone)}`}
                      className={`block rounded px-1.5 py-0.5 text-[10px] leading-tight truncate hover:opacity-80 ${platformTone(e.platform)}`}
                    >
                      <span className="tabular-nums opacity-80">
                        {timeLabel(e.scheduledAt, timezone)}
                      </span>{" "}
                      {e.title?.trim() || "Untitled"}
                    </Link>
                  ))}
                  {day.events.length > 4 ? (
                    <div className="text-[10px] text-ink-500 px-1">
                      +{day.events.length - 4} more
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
