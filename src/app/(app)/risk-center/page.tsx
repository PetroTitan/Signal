"use client";

import { useMemo } from "react";
import { Topbar } from "@/components/topbar";
import { PlatformBadge, RiskBadge } from "@/components/badges";
import { DemoLabel, NotConnectedState } from "@/components/empty-state";
import { useApprovalActions, useSignal } from "@/core/store";
import { useDataMode } from "@/core/data-mode";
import { formatDateTime } from "@/lib/format";
import type { WeeklyPlanItem } from "@/types";

export default function RiskCenterPage() {
  const { state } = useSignal();
  const actions = useApprovalActions();
  const dataMode = useDataMode();

  const breakdown = useMemo(() => {
    const buckets = {
      blocked: [] as WeeklyPlanItem[],
      high: [] as WeeklyPlanItem[],
      medium: [] as WeeklyPlanItem[],
      low: [] as WeeklyPlanItem[],
    };
    for (const item of state.items) {
      if (item.status === "rejected" || item.status === "backlog") continue;
      buckets[item.risk.level].push(item);
    }
    return buckets;
  }, [state.items]);

  if (!dataMode.isDemo && state.items.length === 0) {
    return (
      <>
        <Topbar
          title="Risk center"
          description="Live cadence, tone, and account-fatigue checks."
        />
        <div className="px-6 lg:px-8 py-8 max-w-3xl">
          <NotConnectedState variant="noRiskItems" />
        </div>
      </>
    );
  }

  return (
    <>
      <Topbar
        title="Risk center"
        description="Live cadence, tone, and account-fatigue checks. Recommendations are calm. Action stays with you."
      />

      <div className="px-6 lg:px-8 py-6 max-w-6xl space-y-6">
        {dataMode.isDemo ? <DemoLabel /> : null}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Tile label="Blocked" count={breakdown.blocked.length} tone="blocked" />
          <Tile label="High" count={breakdown.high.length} tone="high" />
          <Tile label="Medium" count={breakdown.medium.length} tone="medium" />
          <Tile label="Low / OK" count={breakdown.low.length} tone="low" />
        </div>

        <Section
          title="Blocked"
          hint="Holding publishing. Move to backlog or fix underlying signal."
          items={breakdown.blocked}
          actions={actions}
        />
        <Section
          title="High risk"
          hint="Recommended cooldown or softer tone."
          items={breakdown.high}
          actions={actions}
        />
        <Section
          title="Medium risk"
          hint="Consider softening, removing the link, or delaying."
          items={breakdown.medium}
          actions={actions}
        />
        <Section
          title="Low risk"
          hint="Within tone and cadence guidance."
          items={breakdown.low.slice(0, 6)}
          actions={actions}
        />
      </div>
    </>
  );
}

function Section({
  title,
  hint,
  items,
  actions,
}: {
  title: string;
  hint: string;
  items: WeeklyPlanItem[];
  actions: ReturnType<typeof useApprovalActions>;
}) {
  const { state } = useSignal();
  if (items.length === 0) return null;
  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-ink-900">{title}</div>
          <div className="text-xs text-ink-500">{items.length} item{items.length === 1 ? "" : "s"}</div>
        </div>
        <p className="text-xs text-ink-500 mt-0.5">{hint}</p>
      </header>
      <ul className="row-divider">
        {items.map((item) => {
          const acc = state.accountsById[item.accountId];
          const product = state.productsById[item.productId];
          return (
            <li key={item.id} className="px-5 py-3.5">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <RiskBadge level={item.risk.level} score={item.risk.score} />
                <PlatformBadge platform={item.platform} />
                <span className="text-xs text-ink-500">
                  {product?.name} · {acc?.displayName}
                </span>
                <span className="ml-auto text-xs text-ink-400">
                  {formatDateTime(item.scheduledFor)}
                </span>
              </div>
              <div className="text-sm text-ink-900 font-medium">
                {item.draft.hook}
              </div>
              {item.risk.reasons.length > 0 ? (
                <ul className="text-xs text-ink-700 mt-1.5 space-y-0.5">
                  {item.risk.reasons.slice(0, 4).map((r) => (
                    <li key={r}>· {r}</li>
                  ))}
                </ul>
              ) : null}
              <div className="text-xs text-ink-800 mt-2 italic">
                {item.risk.recommendation}
              </div>

              {item.risk.level !== "low" ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {item.draft.trackingLinkId || item.draft.cta ? (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => actions.removeLink(item.id)}
                    >
                      Remove link
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn"
                    onClick={() => actions.rewriteSofter(item.id)}
                  >
                    Rewrite softer
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => actions.delay(item.id, 48)}
                  >
                    Delay 48h
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => actions.saveToBacklog(item.id)}
                  >
                    Save to backlog
                  </button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Tile({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone: "low" | "medium" | "high" | "blocked";
}) {
  const accent =
    tone === "high"
      ? "text-red-700 bg-red-50"
      : tone === "medium"
        ? "text-amber-700 bg-amber-50"
        : tone === "blocked"
          ? "bg-ink-900 text-white"
          : "text-emerald-700 bg-emerald-50";
  return (
    <div className="card-padded">
      <div className="stat-label">{label}</div>
      <div className="flex items-center justify-between mt-1">
        <div className="stat-value">{count}</div>
        <span className={`badge ${accent}`}>{label}</span>
      </div>
    </div>
  );
}
