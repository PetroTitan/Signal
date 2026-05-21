"use client";

import { useMemo } from "react";
import { Topbar } from "@/components/topbar";
import { PlatformBadge, RiskBadge } from "@/components/badges";
import { useSignal } from "@/core/store";
import { summarizePlan } from "@/core/approval";
import { formatDateRange, formatDateTime } from "@/lib/format";
import type { WeeklyPlanItem } from "@/types";

export default function WeeklyPlanPage() {
  const { state } = useSignal();
  const items = useMemo(
    () =>
      [...state.items].sort(
        (a, b) =>
          new Date(a.scheduledFor).getTime() -
          new Date(b.scheduledFor).getTime(),
      ),
    [state.items],
  );
  const summary = useMemo(() => summarizePlan(state.items), [state.items]);

  return (
    <>
      <Topbar
        title="Weekly plan"
        description={`Week of ${formatDateRange(state.plan.weekStartIso, state.plan.weekEndIso)} · approve once, distribute organically.`}
      />
      <div className="px-6 lg:px-8 py-6 max-w-7xl space-y-6">
        <SummaryStrip summary={summary} />
        <PlatformAndAccountStrip />

        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-ink-50 text-ink-500 text-xs uppercase tracking-wide">
              <tr>
                <Th>Day · time</Th>
                <Th>Platform</Th>
                <Th>Account</Th>
                <Th>Product</Th>
                <Th>Type</Th>
                <Th className="w-2/5">Hook · body preview</Th>
                <Th>CTA</Th>
                <Th>Risk</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody className="row-divider">
              {items.map((item) => (
                <Row key={item.id} item={item} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function Row({ item }: { item: WeeklyPlanItem }) {
  const { state } = useSignal();
  const acc = state.accountsById[item.accountId];
  const product = state.productsById[item.productId];
  return (
    <tr className="hover:bg-ink-50/60">
      <Td className="font-mono text-xs text-ink-600 whitespace-nowrap">
        {formatDateTime(item.scheduledFor)}
      </Td>
      <Td>
        <PlatformBadge platform={item.platform} />
      </Td>
      <Td className="whitespace-nowrap">
        <div className="text-ink-900">{acc?.displayName}</div>
        {acc?.handle ? (
          <div className="text-xs text-ink-500">{acc.handle}</div>
        ) : null}
      </Td>
      <Td>{product?.name}</Td>
      <Td className="capitalize text-ink-700">
        {item.contentType.replace(/_/g, " ")}
      </Td>
      <Td>
        <div className="font-medium text-ink-900">{item.draft.hook}</div>
        <div className="text-xs text-ink-500 mt-0.5 line-clamp-2 max-w-md">
          {item.draft.body}
        </div>
      </Td>
      <Td className="text-xs">
        {item.draft.cta ? (
          <span className="text-ink-800">{item.draft.cta}</span>
        ) : (
          <span className="text-ink-400">—</span>
        )}
      </Td>
      <Td>
        <RiskBadge level={item.risk.level} score={item.risk.score} />
      </Td>
      <Td>
        <StatusBadge status={item.status} />
      </Td>
    </tr>
  );
}

function SummaryStrip({ summary }: { summary: ReturnType<typeof summarizePlan> }) {
  const blocks: { label: string; value: number; tone?: string }[] = [
    { label: "Total items", value: summary.total },
    { label: "Approved", value: summary.byStatus.approved ?? 0, tone: "emerald" },
    {
      label: "Pending",
      value: summary.byStatus.pending_approval ?? 0,
      tone: "amber",
    },
    { label: "Rejected", value: summary.byStatus.rejected ?? 0, tone: "red" },
    { label: "Backlog", value: summary.byStatus.backlog ?? 0 },
    { label: "Scheduled", value: summary.byStatus.scheduled ?? 0 },
    { label: "Low risk", value: summary.byRisk.low ?? 0, tone: "emerald" },
    { label: "Medium risk", value: summary.byRisk.medium ?? 0, tone: "amber" },
    { label: "High risk", value: summary.byRisk.high ?? 0, tone: "red" },
    { label: "Blocked", value: summary.byRisk.blocked ?? 0, tone: "ink" },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
      {blocks.map((b) => (
        <div key={b.label} className="card-padded py-3">
          <div className="stat-label">{b.label}</div>
          <div
            className={`text-xl font-semibold mt-1 ${toneClass(b.tone)}`}
          >
            {b.value}
          </div>
        </div>
      ))}
    </div>
  );
}

function PlatformAndAccountStrip() {
  const { state } = useSignal();
  const summary = useMemo(() => summarizePlan(state.items), [state.items]);
  const accountTop = Object.entries(summary.byAccount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <section className="card">
        <header className="px-5 py-3 border-b border-ink-100 text-sm font-semibold text-ink-900">
          Platform distribution
        </header>
        <ul className="px-5 py-3 space-y-2">
          {(["reddit", "x", "linkedin"] as const).map((p) => {
            const c = summary.byPlatform[p] ?? 0;
            const pct = Math.min(100, summary.total ? (c / summary.total) * 100 : 0);
            return (
              <li key={p}>
                <div className="flex items-center justify-between mb-1">
                  <PlatformBadge platform={p} />
                  <span className="text-xs text-ink-500">{c} items</span>
                </div>
                <div className="h-1.5 bg-ink-100 rounded-full overflow-hidden">
                  <div className="h-full bg-signal-500" style={{ width: `${pct}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="card">
        <header className="px-5 py-3 border-b border-ink-100 text-sm font-semibold text-ink-900">
          Top accounts this week
        </header>
        <ul className="row-divider">
          {accountTop.map(([accId, count]) => {
            const acc = state.accountsById[accId];
            if (!acc) return null;
            return (
              <li
                key={accId}
                className="px-5 py-2.5 flex items-center justify-between"
              >
                <div>
                  <div className="text-sm text-ink-900">{acc.displayName}</div>
                  <div className="text-xs text-ink-500">{acc.handle ?? ""}</div>
                </div>
                <span className="text-sm font-medium text-ink-800">{count}</span>
              </li>
            );
          })}
          {accountTop.length === 0 ? (
            <li className="px-5 py-3 text-sm text-ink-500">No items planned.</li>
          ) : null}
        </ul>
      </section>
    </div>
  );
}

function Th({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th className={`text-left font-semibold px-4 py-2.5 ${className}`}>
      {children}
    </th>
  );
}

function Td({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-4 py-3 align-top ${className}`}>{children}</td>;
}

const statusTones: Record<string, string> = {
  draft: "bg-ink-100 text-ink-700",
  pending_approval: "bg-amber-50 text-amber-700",
  approved: "bg-emerald-50 text-emerald-700",
  rejected: "bg-red-50 text-red-700",
  scheduled: "bg-signal-50 text-signal-700",
  published: "bg-ink-100 text-ink-700",
  skipped: "bg-ink-100 text-ink-500",
  backlog: "bg-ink-100 text-ink-500",
  paused: "bg-ink-100 text-ink-500",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`badge ${statusTones[status] ?? "badge-neutral"}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

function toneClass(tone?: string) {
  if (tone === "emerald") return "text-emerald-700";
  if (tone === "amber") return "text-amber-700";
  if (tone === "red") return "text-red-700";
  if (tone === "ink") return "text-ink-700";
  return "text-ink-900";
}
