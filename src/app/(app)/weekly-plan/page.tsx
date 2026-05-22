"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { PlatformBadge, RiskBadge } from "@/components/badges";
import { useSignal } from "@/core/store";
import { formatDateTime } from "@/lib/format";
import type { WeeklyPlanItem } from "@/types";

const statusLabels: Record<string, string> = {
  draft: "draft",
  pending_approval: "pending",
  approved: "approved",
  rejected: "rejected",
  scheduled: "scheduled",
  published: "published",
  skipped: "skipped",
  backlog: "backlog",
  paused: "paused",
};

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

  return (
    <>
      <Topbar
        title="Weekly plan"
        description="Everything planned for this week, in one calm list."
      />
      <div className="px-6 lg:px-10 py-8 max-w-4xl">
        {items.length === 0 ? (
          <div className="text-center py-16 max-w-md mx-auto">
            <h2 className="text-base font-semibold text-ink-900">
              No weekly plan yet
            </h2>
            <p className="text-sm text-ink-500 mt-2 leading-relaxed">
              Create a product profile and add an account before generating a
              weekly plan.
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <Link href="/products" className="btn">
                Add product
              </Link>
              <Link href="/accounts/new" className="btn-primary">
                Add account
              </Link>
            </div>
          </div>
        ) : (
          <ul className="space-y-3">
            {items.map((item) => (
              <ItemRow key={item.id} item={item} />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function ItemRow({ item }: { item: WeeklyPlanItem }) {
  const { state } = useSignal();
  const acc = state.accountsById[item.accountId];
  const product = state.productsById[item.productId];
  return (
    <li className="card p-4">
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <PlatformBadge platform={item.platform} />
        <span className="text-xs text-ink-500">{acc?.displayName}</span>
        <span className="text-xs text-ink-400">· {product?.name}</span>
        <span className="text-xs text-ink-500 capitalize ml-auto">
          {statusLabels[item.status] ?? item.status}
        </span>
      </div>
      <div className="text-sm font-medium text-ink-900 leading-snug">
        {item.draft.hook}
      </div>
      <div className="text-xs text-ink-500 mt-1 font-mono">
        {formatDateTime(item.scheduledFor)}
      </div>
      <div className="mt-2">
        <RiskBadge level={item.risk.level} score={item.risk.score} />
      </div>
    </li>
  );
}
