/**
 * Phase B7 — scheduler heartbeat card.
 *
 * Pure server component over a {@link SchedulerHealth} snapshot built
 * from real, observable state (queue counts + cron cadence). It never
 * shows synthetic values: the "last publish" line is explicitly a
 * proxy signal, and authoritative last-tick timestamps are a noted
 * follow-up (they need tick-run persistence).
 */

import type { SchedulerHealth } from "@/core/publishing/scheduler-health";

const STATE_META: Record<
  SchedulerHealth["state"],
  { label: string; cls: string; dot: string }
> = {
  idle: { label: "Idle", cls: "text-ink-600 bg-ink-100 border-ink-200", dot: "bg-ink-400" },
  active: { label: "Active", cls: "text-signal-700 bg-signal-50 border-signal-200", dot: "bg-signal-500" },
  running: { label: "Publishing now", cls: "text-emerald-700 bg-emerald-50 border-emerald-200", dot: "bg-emerald-500" },
  backlogged: { label: "Backlogged", cls: "text-amber-700 bg-amber-50 border-amber-200", dot: "bg-amber-500" },
};

function relative(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const ms = Date.now() - d.getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function SchedulerHealthCard({ health }: { health: SchedulerHealth }) {
  const meta = STATE_META[health.state];
  return (
    <section className="card p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink-900">Scheduler</h2>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${meta.cls}`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} aria-hidden />
          {meta.label}
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat value={health.scheduledCount} label="Scheduled" />
        <Stat value={health.retryQueueCount} label="Retry queue" />
        <Stat value={health.runningNowCount} label="Publishing now" />
        <Stat
          value={health.minutesToNextTick <= 0 ? "now" : `~${health.minutesToNextTick}m`}
          label="Next run"
        />
      </div>
      <p className="text-[11px] text-ink-500">
        Last publish: {relative(health.lastObservedPublishAtIso)}. The scheduler
        runs on a fixed cron; per-tick run history is a planned addition.
      </p>
    </section>
  );
}

function Stat({ value, label }: { value: number | string; label: string }) {
  return (
    <div>
      <div className="text-xl font-semibold text-ink-900 tabular-nums">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-ink-500 font-medium">{label}</div>
    </div>
  );
}
