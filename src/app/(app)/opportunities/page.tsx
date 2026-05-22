"use client";

import { useMemo, useState } from "react";
import { Topbar } from "@/components/topbar";
import { PlatformBadge } from "@/components/badges";
import { useSignal } from "@/core/store";
import { buildOpportunitiesForInsight } from "@/core/content-intelligence";
import { adaptToGoogle } from "@/core/platform-adapters";
import {
  contentAssets as allContentAssets,
  sourceInsights as allSourceInsights,
} from "@/lib/mock";
import { useDemoData } from "@/lib/demo-data";
import type {
  ContentOpportunity,
  DiscoverabilityOpportunity,
  OpportunityChannel,
  OpportunityImpact,
  PlatformId,
} from "@/types";

type Tab = "all" | PlatformId | "google";

export default function OpportunitiesPage() {
  const { state } = useSignal();
  const [tab, setTab] = useState<Tab>("all");

  const sourceInsights = useDemoData(allSourceInsights);
  const contentAssets = useDemoData(allContentAssets);

  const aggregate = useMemo(() => {
    const content: ContentOpportunity[] = [];
    const google: DiscoverabilityOpportunity[] = [];
    for (const insight of sourceInsights) {
      const product = state.productsById[insight.productId];
      if (!product) continue;
      content.push(...buildOpportunitiesForInsight({ insight, product }));
      google.push(
        ...adaptToGoogle({ insight, product, assets: contentAssets }),
      );
    }
    return { content, google };
  }, [state.productsById, sourceInsights, contentAssets]);

  const counts = useMemo(() => {
    return {
      all: aggregate.content.length + aggregate.google.length,
      reddit: aggregate.content.filter((o) => o.channel === "reddit").length,
      x: aggregate.content.filter((o) => o.channel === "x").length,
      linkedin: aggregate.content.filter((o) => o.channel === "linkedin").length,
      google: aggregate.google.length,
    };
  }, [aggregate]);

  const visibleContent = useMemo(() => {
    const sorted = [...aggregate.content].sort(
      (a, b) => weight(b.impact) - weight(a.impact),
    );
    if (tab === "all") return sorted.slice(0, 8);
    if (tab === "google") return [];
    return sorted.filter((o) => o.channel === tab).slice(0, 8);
  }, [aggregate.content, tab]);

  const visibleGoogle = useMemo(() => {
    if (tab === "all" || tab === "google") return aggregate.google.slice(0, 4);
    return [];
  }, [aggregate.google, tab]);

  return (
    <>
      <Topbar
        title="Opportunities"
        description="What's worth doing this week, sorted by impact."
      />

      <div className="px-6 lg:px-10 py-8 space-y-6 max-w-4xl">
        <FilterBar tab={tab} setTab={setTab} counts={counts} />
        {visibleContent.length === 0 && visibleGoogle.length === 0 ? (
          <div className="text-sm text-ink-500 py-12 text-center">
            No opportunities right now.
          </div>
        ) : (
          <ul className="space-y-3">
            {visibleContent.map((o) => (
              <ContentRow key={o.id} opportunity={o} />
            ))}
            {visibleGoogle.map((o) => (
              <GoogleRow key={o.id} opportunity={o} />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function FilterBar({
  tab,
  setTab,
  counts,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  counts: Record<"all" | OpportunityChannel, number>;
}) {
  const buttons: { key: Tab; label: string }[] = [
    { key: "all", label: "All" },
    { key: "reddit", label: "Reddit" },
    { key: "x", label: "X" },
    { key: "linkedin", label: "LinkedIn" },
    { key: "google", label: "Google" },
  ];
  return (
    <div className="inline-flex flex-wrap gap-1">
      {buttons.map((b) => (
        <button
          key={b.key}
          type="button"
          onClick={() => setTab(b.key)}
          className={`text-xs px-3 py-1.5 rounded-md font-medium transition-colors ${
            tab === b.key
              ? "bg-ink-900 text-white"
              : "text-ink-600 hover:bg-ink-100"
          }`}
        >
          {b.label}
          <span className={tab === b.key ? "text-ink-300 ml-1.5" : "text-ink-400 ml-1.5"}>
            {counts[b.key]}
          </span>
        </button>
      ))}
    </div>
  );
}

function ContentRow({ opportunity }: { opportunity: ContentOpportunity }) {
  const { state } = useSignal();
  const product = state.productsById[opportunity.productId];
  const platform = opportunity.channel as PlatformId;
  return (
    <li className="card p-4">
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <PlatformBadge platform={platform} />
        <span className="text-xs text-ink-500 capitalize">
          {opportunity.kind.replace(/_/g, " ")}
        </span>
        <ImpactChip impact={opportunity.impact} />
        <span className="text-xs text-ink-500 ml-auto">{product?.name}</span>
      </div>
      <div className="text-sm font-medium text-ink-900 leading-snug">
        {opportunity.title}
      </div>
      <p className="text-xs text-ink-600 mt-1.5 leading-relaxed">
        {opportunity.rationale}
      </p>
    </li>
  );
}

function GoogleRow({ opportunity }: { opportunity: DiscoverabilityOpportunity }) {
  return (
    <li className="card p-4">
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <span className="badge bg-ink-900 text-white">Google</span>
        <span className="text-xs text-ink-500 capitalize">
          {opportunity.kind.replace(/_/g, " ")}
        </span>
        <ImpactChip impact={opportunity.impact} />
      </div>
      <div className="text-sm font-medium text-ink-900 leading-snug">
        {opportunity.title}
      </div>
      <p className="text-xs text-ink-600 mt-1.5 leading-relaxed">
        {opportunity.detail}
      </p>
      <p className="text-xs text-ink-800 mt-1 italic">{opportunity.suggestedAction}</p>
    </li>
  );
}

function ImpactChip({ impact }: { impact: OpportunityImpact }) {
  const tone =
    impact === "high"
      ? "bg-ink-900 text-white"
      : impact === "medium"
        ? "bg-ink-100 text-ink-700"
        : "bg-ink-100 text-ink-500";
  return <span className={`badge text-[10px] ${tone}`}>{impact}</span>;
}

function weight(impact: OpportunityImpact): number {
  return impact === "high" ? 3 : impact === "medium" ? 2 : 1;
}
