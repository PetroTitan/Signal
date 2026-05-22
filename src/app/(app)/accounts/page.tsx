"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { PlatformBadge, AccountStatusBadge } from "@/components/badges";
import { ChevronRightIcon } from "@/components/icons";
import { TrustPanel } from "@/components/trust-panel";
import { useAccounts, useSignal } from "@/core/store";
import { computeReadiness, planningEligibility } from "@/core/onboarding";
import type { AccountStatus } from "@/types";

type Filter = "all" | "eligible" | "in_setup" | "paused";

export default function AccountsPage() {
  const accounts = useAccounts();
  const { state } = useSignal();
  const [filter, setFilter] = useState<Filter>("all");

  const counts = useMemo(() => {
    const eligibleStatuses: AccountStatus[] = [
      "warming",
      "active",
      "connected",
      "ready_to_connect",
    ];
    const setupStatuses: AccountStatus[] = [
      "planned",
      "setup_needed",
      "awaiting_manual_creation",
    ];
    return {
      all: accounts.length,
      eligible: accounts.filter((a) => eligibleStatuses.includes(a.status)).length,
      in_setup: accounts.filter((a) => setupStatuses.includes(a.status)).length,
      paused: accounts.filter((a) => a.status === "paused").length,
    };
  }, [accounts]);

  const visible = useMemo(() => {
    const sorted = [...accounts].sort(
      (a, b) => computeReadiness(b) - computeReadiness(a),
    );
    if (filter === "all") return sorted;
    return sorted.filter((a) => {
      const e = planningEligibility(a);
      if (filter === "eligible") return e.eligible;
      if (filter === "paused") return a.status === "paused";
      return (
        a.status === "planned" ||
        a.status === "setup_needed" ||
        a.status === "awaiting_manual_creation"
      );
    });
  }, [accounts, filter]);

  return (
    <>
      <Topbar
        title="Accounts"
        description="Each account belongs to a product and a platform. Signal connects only via official OAuth."
        actions={
          <Link href="/accounts/new" className="btn-primary">
            New account
          </Link>
        }
      />

      <div className="px-6 lg:px-8 py-6 max-w-7xl space-y-6">
        <TrustPanel />

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Total" value={counts.all} />
          <Stat label="Eligible for planning" value={counts.eligible} tone="emerald" />
          <Stat label="In setup" value={counts.in_setup} tone="amber" />
          <Stat label="Paused" value={counts.paused} tone="ink" />
        </div>

        <FilterBar filter={filter} setFilter={setFilter} counts={counts} />

        <section className="card">
          <div className="px-5 py-3.5 border-b border-ink-100 flex items-center justify-between">
            <div className="text-sm font-semibold text-ink-900">
              {visible.length} {visible.length === 1 ? "account" : "accounts"}
            </div>
            <div className="text-xs text-ink-500">Sorted by readiness</div>
          </div>
          {visible.length === 0 ? (
            <div className="px-5 py-6 text-sm text-ink-500">
              Nothing in this view.
            </div>
          ) : (
            <ul className="row-divider">
              {visible.map((a) => {
                const product = state.productsById[a.productId];
                const eligibility = planningEligibility(a);
                const readiness = computeReadiness(a);
                return (
                  <li key={a.id}>
                    <Link
                      href={`/accounts/${a.id}`}
                      className="flex items-center gap-4 px-5 py-3.5 hover:bg-ink-50/60 transition-colors"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-ink-900 truncate">
                          {a.displayName}
                          {a.handle ? (
                            <span className="ml-2 text-xs text-ink-500 font-normal">
                              {a.handle}
                            </span>
                          ) : null}
                        </div>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          <PlatformBadge platform={a.platform} />
                          <span className="text-xs text-ink-500 capitalize">
                            {a.role} · {product?.name}
                          </span>
                          <AccountStatusBadge status={a.status} />
                          {eligibility.eligible ? (
                            <span className="badge-low">Eligible</span>
                          ) : (
                            <span className="badge-medium">Not eligible</span>
                          )}
                        </div>
                      </div>
                      <div className="text-right shrink-0 hidden sm:block">
                        <div className="text-sm font-medium text-ink-900">
                          {readiness}%
                        </div>
                        <div className="text-[11px] text-ink-500">readiness</div>
                      </div>
                      <ChevronRightIcon className="text-ink-400" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}

function FilterBar({
  filter,
  setFilter,
  counts,
}: {
  filter: Filter;
  setFilter: (f: Filter) => void;
  counts: Record<Filter, number>;
}) {
  const buttons: { key: Filter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "eligible", label: "Eligible" },
    { key: "in_setup", label: "In setup" },
    { key: "paused", label: "Paused" },
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

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "emerald" | "amber" | "ink";
}) {
  const toneClass =
    tone === "emerald"
      ? "text-emerald-700"
      : tone === "amber"
        ? "text-amber-700"
        : tone === "ink"
          ? "text-ink-700"
          : "text-ink-900";
  return (
    <div className="card-padded">
      <div className="stat-label">{label}</div>
      <div className={`text-2xl font-semibold mt-1 ${toneClass}`}>{value}</div>
    </div>
  );
}

