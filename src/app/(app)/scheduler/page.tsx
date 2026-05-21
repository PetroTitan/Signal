import type { Metadata } from "next";
import { Topbar } from "@/components/topbar";
import { PlatformBadge, RiskBadge } from "@/components/badges";
import {
  accountsById,
  currentWeeklyPlan,
  productsById,
  weeklyPlanItems,
} from "@/lib/mock";
import { formatDateRange } from "@/lib/format";

export const metadata: Metadata = { title: "Scheduler" };

const dayLabels = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

export default function SchedulerPage() {
  const start = new Date(currentWeeklyPlan.weekStartIso);

  const days = Array.from({ length: 7 }).map((_, i) => {
    const day = new Date(start);
    day.setUTCDate(start.getUTCDate() + i);
    const dayStart = new Date(day);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(day);
    dayEnd.setUTCHours(23, 59, 59, 999);

    const items = weeklyPlanItems
      .filter((it) => {
        const t = new Date(it.scheduledFor).getTime();
        return t >= dayStart.getTime() && t <= dayEnd.getTime();
      })
      .sort(
        (a, b) =>
          new Date(a.scheduledFor).getTime() -
          new Date(b.scheduledFor).getTime(),
      );

    return {
      label: dayLabels[i],
      date: day,
      items,
    };
  });

  return (
    <>
      <Topbar
        title="Scheduler"
        description={`Week of ${formatDateRange(currentWeeklyPlan.weekStartIso, currentWeeklyPlan.weekEndIso)} · Sustainable cadence, staggered across the week.`}
      />

      <div className="px-6 lg:px-8 py-6 max-w-7xl space-y-6">
        <CadenceCallout />

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-7 gap-3">
          {days.map((d) => (
            <div
              key={d.label}
              className="card flex flex-col min-h-[280px]"
            >
              <div className="px-3 py-2.5 border-b border-ink-100">
                <div className="text-[11px] uppercase tracking-wide text-ink-500 font-semibold">
                  {d.label}
                </div>
                <div className="text-sm text-ink-900 font-medium">
                  {d.date.toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })}
                </div>
              </div>
              <ul className="flex-1 p-2 space-y-2">
                {d.items.length === 0 ? (
                  <li className="text-[11px] text-ink-400 italic px-1 py-3">
                    Quiet day. Spacing matters.
                  </li>
                ) : (
                  d.items.map((it) => {
                    const acc = accountsById[it.accountId];
                    const product = productsById[it.productId];
                    return (
                      <li
                        key={it.id}
                        className="rounded-md border border-ink-100 p-2 bg-white hover:border-signal-200 transition-colors"
                      >
                        <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                          <PlatformBadge platform={it.platform} />
                          <RiskBadge level={it.riskLevel} />
                        </div>
                        <div className="text-[11px] text-ink-500 font-mono">
                          {new Date(it.scheduledFor).toLocaleTimeString("en-US", {
                            hour: "numeric",
                            minute: "2-digit",
                          })}
                        </div>
                        <div className="text-xs font-medium text-ink-900 mt-1 line-clamp-2">
                          {it.draft.hook}
                        </div>
                        <div className="text-[11px] text-ink-500 mt-1">
                          {product.name} · {acc.displayName}
                        </div>
                        <div className="text-[11px] text-ink-400 mt-0.5 capitalize">
                          {it.contentType.replace(/_/g, " ")}
                        </div>
                      </li>
                    );
                  })
                )}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function CadenceCallout() {
  return (
    <div className="card border-emerald-200 bg-emerald-50/40">
      <div className="p-4 text-sm text-ink-700 leading-relaxed">
        <span className="font-semibold text-ink-900">Sustainable cadence.</span>{" "}
        Items are spaced across the week to respect platform cadence and account
        cooldown. Signal will not concentrate posts. If you feel the urge to add
        more, save to the backlog and let next week absorb it.
      </div>
    </div>
  );
}
