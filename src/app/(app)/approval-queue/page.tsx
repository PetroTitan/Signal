"use client";

import { useMemo, useState } from "react";
import { Topbar } from "@/components/topbar";
import { PlatformBadge, RiskBadge } from "@/components/badges";
import { CadenceCallout } from "@/components/cadence-callout";
import { useApprovalActions, useSignal } from "@/core/store";
import { formatDateTime, relativeFromNow } from "@/lib/format";
import type { WeeklyPlanItem } from "@/types";

export default function ApprovalQueuePage() {
  const { state } = useSignal();
  const actions = useApprovalActions();
  const [filter, setFilter] = useState<"all" | "low" | "medium" | "high" | "blocked">(
    "all",
  );

  const pending = useMemo(
    () => state.items.filter((i) => i.status === "pending_approval"),
    [state.items],
  );
  const visible = useMemo(
    () => (filter === "all" ? pending : pending.filter((i) => i.risk.level === filter)),
    [pending, filter],
  );
  const lowRiskPending = pending.filter((i) => i.risk.level === "low").length;

  return (
    <>
      <Topbar
        title="Review this week"
        description="Approve, soften, or move to the backlog. One pass."
        actions={
          lowRiskPending > 0 ? (
            <button
              type="button"
              className="btn-primary"
              onClick={() => actions.approveAllLowRisk()}
            >
              Approve all low-risk ({lowRiskPending})
            </button>
          ) : null
        }
      />

      <div className="px-6 lg:px-10 py-8 max-w-3xl space-y-6">
        <CadenceCallout />
        {pending.length > 0 ? (
          <FilterBar filter={filter} setFilter={setFilter} pending={pending} />
        ) : null}

        {visible.length === 0 ? (
          <div className="text-center py-16 max-w-md mx-auto">
            <h2 className="text-base font-semibold text-ink-900">
              {pending.length === 0
                ? "No items awaiting approval"
                : "Nothing in this risk bucket"}
            </h2>
            <p className="text-sm text-ink-500 mt-2 leading-relaxed">
              {pending.length === 0
                ? "Approved weekly plans will appear here after you generate drafts."
                : "Try another filter."}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {visible.map((item) => (
              <ItemCard key={item.id} item={item} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function FilterBar({
  filter,
  setFilter,
  pending,
}: {
  filter: "all" | "low" | "medium" | "high" | "blocked";
  setFilter: (f: "all" | "low" | "medium" | "high" | "blocked") => void;
  pending: WeeklyPlanItem[];
}) {
  const counts = {
    all: pending.length,
    low: pending.filter((i) => i.risk.level === "low").length,
    medium: pending.filter((i) => i.risk.level === "medium").length,
    high: pending.filter((i) => i.risk.level === "high").length,
    blocked: pending.filter((i) => i.risk.level === "blocked").length,
  };
  const buttons: { key: typeof filter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "low", label: "Low" },
    { key: "medium", label: "Medium" },
    { key: "high", label: "High" },
    { key: "blocked", label: "Blocked" },
  ];
  return (
    <div className="card p-1.5 inline-flex flex-wrap gap-1">
      {buttons.map((b) => (
        <button
          key={b.key}
          type="button"
          onClick={() => setFilter(b.key)}
          className={`text-xs px-2.5 py-1 rounded-md font-medium transition-colors ${
            filter === b.key
              ? "bg-ink-900 text-white"
              : "text-ink-600 hover:bg-ink-100"
          }`}
        >
          {b.label}{" "}
          <span className={filter === b.key ? "text-ink-300" : "text-ink-400"}>
            ({counts[b.key]})
          </span>
        </button>
      ))}
    </div>
  );
}

function ItemCard({ item }: { item: WeeklyPlanItem }) {
  const { state } = useSignal();
  const actions = useApprovalActions();
  const acc = state.accountsById[item.accountId];
  const product = state.productsById[item.productId];

  return (
    <article className="card">
      <header className="px-5 py-3.5 border-b border-ink-100 flex items-center gap-2 flex-wrap">
        <PlatformBadge platform={item.platform} />
        <span className="text-sm text-ink-800 font-medium">
          {acc.displayName}
        </span>
        <span className="text-xs text-ink-500">· {product.name}</span>
        <span className="text-xs text-ink-500">
          · {item.contentType.replace(/_/g, " ")}
        </span>
        <span className="ml-auto text-xs text-ink-500">
          {formatDateTime(item.scheduledFor)} ·{" "}
          {relativeFromNow(item.scheduledFor)}
        </span>
        <RiskBadge level={item.risk.level} score={item.risk.score} />
      </header>

      <div className="px-5 py-4">
        <div className="text-base font-semibold text-ink-900">
          {item.draft.hook}
        </div>
        <p className="text-sm text-ink-700 mt-2 leading-relaxed whitespace-pre-line">
          {item.draft.body}
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {item.draft.cta ? (
            <span className="text-xs text-ink-600">
              <span className="text-ink-400">CTA · </span>
              {item.draft.cta}
            </span>
          ) : (
            <span className="text-xs text-ink-500">No CTA</span>
          )}
        </div>

        {item.risk.reasons.length > 0 ? (
          <div className="mt-3 border-t border-ink-100 pt-3">
            <div className="stat-label mb-1">Risk reasons</div>
            <ul className="text-sm text-ink-700 space-y-1">
              {item.risk.reasons.map((n) => (
                <li key={n}>· {n}</li>
              ))}
            </ul>
            <div className="mt-2 text-sm text-ink-800 italic">
              {item.risk.recommendation}
            </div>
          </div>
        ) : null}
      </div>

      <footer className="px-5 py-3 border-t border-ink-100 flex flex-wrap items-center gap-2 bg-ink-50/40">
        <button
          type="button"
          className="btn-primary"
          onClick={() => actions.approve(item.id)}
        >
          Approve
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => actions.rewriteSofter(item.id)}
        >
          Soften
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => actions.saveToBacklog(item.id)}
        >
          Move to backlog
        </button>
        <button
          type="button"
          className="btn-ghost text-ink-500 ml-auto"
          onClick={() => actions.reject(item.id)}
        >
          Reject
        </button>
      </footer>
    </article>
  );
}
