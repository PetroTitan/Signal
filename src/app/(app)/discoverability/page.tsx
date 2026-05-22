"use client";

import { useMemo } from "react";
import { Topbar } from "@/components/topbar";
import { useSignal } from "@/core/store";
import { calculateDiscoverabilityOpportunities } from "@/core/discoverability";
import { contentAssets as allContentAssets } from "@/lib/mock";
import { useDemoData } from "@/lib/demo-data";
import type { DiscoverabilityOpportunity } from "@/types";

export default function DiscoverabilityPage() {
  const { state } = useSignal();
  const products = useMemo(
    () => Object.values(state.productsById),
    [state.productsById],
  );

  const contentAssets = useDemoData(allContentAssets);

  const opportunities = useMemo(
    () => calculateDiscoverabilityOpportunities(contentAssets, products),
    [products, contentAssets],
  );

  const top = opportunities.slice(0, 6);

  return (
    <>
      <Topbar
        title="Discoverability"
        description="Where search and social can help each other."
      />

      <div className="px-6 lg:px-10 py-8 space-y-4 max-w-4xl">
        {top.length === 0 ? (
          <div className="text-sm text-ink-500 py-12 text-center">
            No discoverability opportunities right now.
          </div>
        ) : (
          <ul className="space-y-3">
            {top.map((o) => (
              <OpportunityRow key={o.id} opportunity={o} />
            ))}
          </ul>
        )}
        <p className="text-xs text-ink-500 text-center pt-4">
          WebmasterID is not yet connected. Numbers will replace these
          calculations once it is.
        </p>
      </div>
    </>
  );
}

function OpportunityRow({
  opportunity,
}: {
  opportunity: DiscoverabilityOpportunity;
}) {
  return (
    <li className="card p-4">
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <span className="text-xs text-ink-500 capitalize">
          {opportunity.kind.replace(/_/g, " ")}
        </span>
        <span
          className={`badge text-[10px] ml-auto ${
            opportunity.impact === "high"
              ? "bg-ink-900 text-white"
              : opportunity.impact === "medium"
                ? "bg-ink-100 text-ink-700"
                : "bg-ink-100 text-ink-500"
          }`}
        >
          {opportunity.impact}
        </span>
      </div>
      <div className="text-sm font-medium text-ink-900 leading-snug">
        {opportunity.title}
      </div>
      <p className="text-xs text-ink-700 mt-1.5 leading-relaxed">
        {opportunity.detail}
      </p>
      <p className="text-xs text-ink-800 mt-1 italic">
        {opportunity.suggestedAction}
      </p>
    </li>
  );
}
