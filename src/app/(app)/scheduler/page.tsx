"use client";

import { useMemo, useState } from "react";
import { Topbar } from "@/components/topbar";
import { PlatformBadge, RiskBadge } from "@/components/badges";
import { CadenceCallout as LiveCadenceCallout } from "@/components/cadence-callout";
import { useApprovalActions, useSignal } from "@/core/store";
import { accountWeeklyCount } from "@/core/scheduler";
import type { WeeklyPlanItem } from "@/types";

const dayLabels = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

type GroupBy = "day" | "account" | "product";

export default function SchedulerPage() {
  const { state } = useSignal();
  const actions = useApprovalActions();
  const [groupBy, setGroupBy] = useState<GroupBy>("day");

  const scheduledItems = useMemo(
    () =>
      state.items.filter(
        (i) =>
          i.status === "approved" ||
          i.status === "scheduled" ||
          i.status === "pending_approval",
      ),
    [state.items],
  );

  return (
    <>
      <Topbar
        title="Scheduler"
        description="Approved items, spread across the week."
        actions={
          <>
            <GroupSwitch value={groupBy} onChange={setGroupBy} />
            <button
              type="button"
              className="btn"
              onClick={() => actions.redistribute()}
            >
              Redistribute
            </button>
          </>
        }
      />

      <div className="px-6 lg:px-10 py-8 max-w-6xl space-y-6">
        {scheduledItems.length === 0 && state.backlog.length === 0 ? (
          <div className="text-center py-16 max-w-md mx-auto">
            <h2 className="text-base font-semibold text-ink-900">
              Nothing scheduled yet
            </h2>
            <p className="text-sm text-ink-500 mt-2 leading-relaxed">
              Approved items will land here, spread across the week using
              cadence rules.
            </p>
          </div>
        ) : (
          <>
            <LiveCadenceCallout />
            {state.lastMoves.length > 0 ? <MovesPanel /> : null}

            {groupBy === "day" ? (
              <WeeklyGrid items={scheduledItems} />
            ) : groupBy === "account" ? (
              <ByAccount items={scheduledItems} />
            ) : (
              <ByProduct items={scheduledItems} />
            )}

            <BacklogRail />
          </>
        )}
      </div>
    </>
  );
}

function GroupSwitch({
  value,
  onChange,
}: {
  value: GroupBy;
  onChange: (g: GroupBy) => void;
}) {
  const opts: { key: GroupBy; label: string }[] = [
    { key: "day", label: "By day" },
    { key: "account", label: "By account" },
    { key: "product", label: "By product" },
  ];
  return (
    <div className="card p-1 inline-flex">
      {opts.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          className={`text-xs px-2.5 py-1 rounded-md font-medium transition-colors ${
            value === o.key
              ? "bg-ink-900 text-white"
              : "text-ink-600 hover:bg-ink-100"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function WeeklyGrid({ items }: { items: WeeklyPlanItem[] }) {
  const { state } = useSignal();
  const weekStart = new Date(state.plan.weekStartIso);

  const days = Array.from({ length: 7 }).map((_, i) => {
    const day = new Date(weekStart);
    day.setUTCDate(weekStart.getUTCDate() + i);
    const dayStart = new Date(day);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(day);
    dayEnd.setUTCHours(23, 59, 59, 999);
    return {
      label: dayLabels[i],
      date: day,
      items: items
        .filter((it) => {
          const t = new Date(it.scheduledFor).getTime();
          return t >= dayStart.getTime() && t <= dayEnd.getTime();
        })
        .sort(
          (a, b) =>
            new Date(a.scheduledFor).getTime() -
            new Date(b.scheduledFor).getTime(),
        ),
    };
  });

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-7 gap-3">
      {days.map((d) => (
        <div key={d.label} className="card flex flex-col min-h-[280px]">
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
              d.items.map((it) => <ItemTile key={it.id} item={it} compact />)
            )}
          </ul>
        </div>
      ))}
    </div>
  );
}

function ByAccount({ items }: { items: WeeklyPlanItem[] }) {
  const { state } = useSignal();
  const groups = groupBy(items, (i) => i.accountId);
  return (
    <div className="space-y-3">
      {Object.entries(groups).map(([accountId, list]) => {
        const acc = state.accountsById[accountId];
        const weekly = accountWeeklyCount(accountId, items);
        return (
          <section key={accountId} className="card">
            <header className="px-5 py-3.5 border-b border-ink-100 flex items-center gap-2 flex-wrap">
              <div className="text-sm font-semibold text-ink-900">
                {acc?.displayName}
              </div>
              {acc ? <PlatformBadge platform={acc.platform} /> : null}
              <span className="text-xs text-ink-500">{weekly} items this week</span>
            </header>
            <ul className="p-2 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
              {list
                .sort(
                  (a, b) =>
                    new Date(a.scheduledFor).getTime() -
                    new Date(b.scheduledFor).getTime(),
                )
                .map((it) => (
                  <ItemTile key={it.id} item={it} />
                ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function ByProduct({ items }: { items: WeeklyPlanItem[] }) {
  const { state } = useSignal();
  const groups = groupBy(items, (i) => i.productId);
  return (
    <div className="space-y-3">
      {Object.entries(groups).map(([productId, list]) => {
        const product = state.productsById[productId];
        return (
          <section key={productId} className="card">
            <header className="px-5 py-3.5 border-b border-ink-100 flex items-center gap-2">
              <div className="text-sm font-semibold text-ink-900">
                {product?.name}
              </div>
              <span className="text-xs text-ink-500">
                {list.length} items this week
              </span>
            </header>
            <ul className="p-2 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
              {list
                .sort(
                  (a, b) =>
                    new Date(a.scheduledFor).getTime() -
                    new Date(b.scheduledFor).getTime(),
                )
                .map((it) => (
                  <ItemTile key={it.id} item={it} />
                ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function ItemTile({
  item,
  compact = false,
}: {
  item: WeeklyPlanItem;
  compact?: boolean;
}) {
  const { state } = useSignal();
  const acc = state.accountsById[item.accountId];
  const product = state.productsById[item.productId];
  return (
    <li
      className={`rounded-md border border-ink-100 p-2 bg-white hover:border-signal-200 transition-colors ${compact ? "" : "min-h-[110px]"}`}
    >
      <div className="flex items-center gap-1.5 mb-1 flex-wrap">
        <PlatformBadge platform={item.platform} />
        <RiskBadge level={item.risk.level} />
      </div>
      <div className="text-[11px] text-ink-500 font-mono">
        {new Date(item.scheduledFor).toLocaleString("en-US", {
          weekday: "short",
          hour: "numeric",
          minute: "2-digit",
        })}
      </div>
      <div className="text-xs font-medium text-ink-900 mt-1 line-clamp-2">
        {item.draft.hook}
      </div>
      <div className="text-[11px] text-ink-500 mt-1">
        {product?.name} · {acc?.displayName}
      </div>
      <div className="text-[11px] text-ink-400 mt-0.5 capitalize">
        {item.contentType.replace(/_/g, " ")}
      </div>
    </li>
  );
}

function MovesPanel() {
  const { state } = useSignal();
  return (
    <div className="card border-amber-200 bg-amber-50/40">
      <div className="px-5 py-3 border-b border-amber-200">
        <div className="text-sm font-semibold text-ink-900">
          Last redistribution
        </div>
        <div className="text-xs text-ink-600 mt-0.5">
          Recommended publishing windows updated:
        </div>
      </div>
      <ul className="px-5 py-3 space-y-1.5 text-sm text-ink-800">
        {state.lastMoves.slice(0, 5).map((m) => (
          <li key={m.id}>· {m.reason}</li>
        ))}
      </ul>
    </div>
  );
}

function BacklogRail() {
  const { state } = useSignal();
  const actions = useApprovalActions();
  if (state.backlog.length === 0) return null;
  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-ink-900">Backlog</div>
          <div className="text-xs text-ink-500 mt-0.5">
            Items held for future weeks. Restore one only when you have room.
          </div>
        </div>
        <span className="badge-neutral">{state.backlog.length} held</span>
      </header>
      <ul className="row-divider">
        {state.backlog.map((bk) => {
          const acc = state.accountsById[bk.accountId];
          const product = state.productsById[bk.productId];
          return (
            <li key={bk.id} className="px-5 py-3.5 flex items-start gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <PlatformBadge platform={bk.platform} />
                  <span className="text-xs text-ink-500">{product?.name}</span>
                  <span className="text-xs text-ink-500">
                    · {acc?.displayName}
                  </span>
                </div>
                <div className="text-sm font-medium text-ink-900">
                  {bk.draft.hook}
                </div>
                <div className="text-xs text-ink-500 mt-1 italic">
                  {bk.reason}
                </div>
              </div>
              <button
                type="button"
                className="btn shrink-0"
                onClick={() => actions.restoreFromBacklog(bk.id)}
              >
                Restore to this week
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function groupBy<T, K extends string>(items: T[], key: (it: T) => K): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const it of items) {
    const k = key(it);
    (out[k] ?? (out[k] = [])).push(it);
  }
  return out;
}
