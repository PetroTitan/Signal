"use client";

import { Topbar } from "@/components/topbar";
import { PlatformBadge, RiskBadge } from "@/components/badges";
import { useApprovalActions, useSignal } from "@/core/store";
import { formatDateTime } from "@/lib/format";
import type { WeeklyPlanItem } from "@/types";

export default function BacklogPage() {
  const { state } = useSignal();
  const actions = useApprovalActions();
  const backloggedItems = state.items.filter((i) => i.status === "backlog");

  return (
    <>
      <Topbar
        title="Backlog"
        description="Held items, ready to come back when the cadence has room."
      />

      <div className="px-6 lg:px-10 py-8 max-w-4xl space-y-6">
        <section className="card">
          <header className="px-5 py-3.5 border-b border-ink-100 flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-ink-900">
                Held for future weeks
              </div>
              <div className="text-xs text-ink-500 mt-0.5">
                Restore one only when the platform has capacity.
              </div>
            </div>
            <span className="badge-neutral">{state.backlog.length} held</span>
          </header>
          {state.backlog.length === 0 ? (
            <div className="px-5 py-6 text-sm text-ink-500">
              Backlog is empty. Items saved during approval will land here.
            </div>
          ) : (
            <ul className="row-divider">
              {state.backlog.map((bk) => {
                const acc = state.accountsById[bk.accountId];
                const product = state.productsById[bk.productId];
                return (
                  <li key={bk.id} className="px-5 py-4">
                    <div className="flex items-start gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <PlatformBadge platform={bk.platform} />
                          <RiskBadge level={bk.risk.level} />
                          <span className="text-xs text-ink-500">
                            {product?.name} · {acc?.displayName}
                          </span>
                          <span className="ml-auto text-xs text-ink-400">
                            Moved {formatDateTime(bk.movedAt)}
                          </span>
                        </div>
                        <div className="text-sm font-medium text-ink-900">
                          {bk.draft.hook}
                        </div>
                        <p className="text-xs text-ink-600 mt-1 line-clamp-2">
                          {bk.draft.body}
                        </p>
                        <div className="text-xs text-ink-500 mt-1.5 italic">
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
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {backloggedItems.length > 0 ? (
          <RecentlyBacklogged items={backloggedItems} />
        ) : null}
      </div>
    </>
  );
}

function RecentlyBacklogged({ items }: { items: WeeklyPlanItem[] }) {
  const { state } = useSignal();
  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100">
        <div className="text-sm font-semibold text-ink-900">
          Backlogged from this week&apos;s plan
        </div>
        <div className="text-xs text-ink-500 mt-0.5">
          Items moved aside during the most recent approval pass.
        </div>
      </header>
      <ul className="row-divider">
        {items.map((it) => {
          const acc = state.accountsById[it.accountId];
          const product = state.productsById[it.productId];
          return (
            <li key={it.id} className="px-5 py-3">
              <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                <PlatformBadge platform={it.platform} />
                <span className="text-xs text-ink-500">
                  {product?.name} · {acc?.displayName}
                </span>
              </div>
              <div className="text-sm text-ink-900">{it.draft.hook}</div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

