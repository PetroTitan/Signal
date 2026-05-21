"use client";

import { useMemo, useState } from "react";
import { Topbar } from "@/components/topbar";
import { PlatformBadge } from "@/components/badges";
import { useSignal } from "@/core/store";
import {
  buildOpportunitiesForInsight,
  recentlyUsedHooks,
} from "@/core/content-intelligence";
import { adaptToGoogle } from "@/core/platform-adapters";
import { contentAssets, sourceInsights } from "@/lib/mock";
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
  const products = useMemo(
    () => Object.values(state.productsById),
    [state.productsById],
  );
  const knownHooks = useMemo(
    () => recentlyUsedHooks(state.items),
    [state.items],
  );

  const aggregate = useMemo(() => {
    const content: ContentOpportunity[] = [];
    const google: DiscoverabilityOpportunity[] = [];
    for (const insight of sourceInsights) {
      const product = state.productsById[insight.productId];
      if (!product) continue;
      content.push(
        ...buildOpportunitiesForInsight({ insight, product }),
      );
      google.push(
        ...adaptToGoogle({ insight, product, assets: contentAssets }),
      );
    }
    return { content, google };
  }, [state.productsById]);

  const visibleContent = useMemo(() => {
    const sorted = [...aggregate.content].sort(
      (a, b) => weightFor(b.impact) - weightFor(a.impact),
    );
    if (tab === "all") return sorted;
    if (tab === "google") return [];
    return sorted.filter((o) => o.channel === tab);
  }, [aggregate.content, tab]);

  const visibleGoogle = useMemo(() => {
    if (tab === "all" || tab === "google") return aggregate.google;
    return [];
  }, [aggregate.google, tab]);

  const counts = useMemo(() => {
    return {
      all: aggregate.content.length + aggregate.google.length,
      reddit: aggregate.content.filter((o) => o.channel === "reddit").length,
      x: aggregate.content.filter((o) => o.channel === "x").length,
      linkedin: aggregate.content.filter((o) => o.channel === "linkedin").length,
      google: aggregate.google.length,
    };
  }, [aggregate]);

  return (
    <>
      <Topbar
        title="Opportunities"
        description="One view across social and discoverability channels. Sorted by impact, not by volume."
      />

      <div className="px-6 lg:px-8 py-6 max-w-7xl space-y-6">
        <Intro />

        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Stat label="Total" value={counts.all} />
          <Stat label="Reddit" value={counts.reddit} />
          <Stat label="X" value={counts.x} />
          <Stat label="LinkedIn" value={counts.linkedin} />
          <Stat label="Google" value={counts.google} />
        </div>

        <FilterBar value={tab} setTab={setTab} counts={counts} />

        {visibleContent.length === 0 && visibleGoogle.length === 0 ? (
          <div className="card-padded text-sm text-ink-500">
            Nothing surfaced in this view.
          </div>
        ) : (
          <>
            {visibleContent.length > 0 ? (
              <ContentOpportunityList opportunities={visibleContent} knownHooks={knownHooks} />
            ) : null}
            {visibleGoogle.length > 0 ? (
              <GoogleOpportunityList opportunities={visibleGoogle} />
            ) : null}
          </>
        )}
      </div>
    </>
  );
}

function Intro() {
  return (
    <div className="card border-signal-200 bg-signal-50/30 p-4 text-sm leading-relaxed">
      <div className="font-semibold text-ink-900 mb-1">
        Cross-channel opportunity surface.
      </div>
      <p className="text-ink-700">
        Each insight produces multiple platform-specific opportunities and, when
        relevant, a Google discoverability signal. Signal does not flood the
        queue: opportunities are scored by impact, conversation potential, and
        evergreen value. The founder still approves manually.
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="card-padded">
      <div className="stat-label">{label}</div>
      <div className="text-2xl font-semibold text-ink-900 mt-1">{value}</div>
    </div>
  );
}

function FilterBar({
  value,
  setTab,
  counts,
}: {
  value: Tab;
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
    <div className="card p-1.5 inline-flex flex-wrap gap-1">
      {buttons.map((b) => (
        <button
          key={b.key}
          type="button"
          onClick={() => setTab(b.key)}
          className={`text-xs px-2.5 py-1 rounded-md font-medium transition-colors ${
            value === b.key
              ? "bg-ink-900 text-white"
              : "text-ink-600 hover:bg-ink-100"
          }`}
        >
          {b.label}{" "}
          <span className={value === b.key ? "text-ink-300" : "text-ink-400"}>
            ({counts[b.key]})
          </span>
        </button>
      ))}
    </div>
  );
}

function ContentOpportunityList({
  opportunities,
  knownHooks,
}: {
  opportunities: ContentOpportunity[];
  knownHooks: string[];
}) {
  const { state } = useSignal();
  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100">
        <div className="text-sm font-semibold text-ink-900">
          Social opportunities
        </div>
        <p className="text-xs text-ink-500 mt-0.5">
          Insight-derived opportunities ready for draft generation.
        </p>
      </header>
      <ul className="row-divider">
        {opportunities.map((o) => {
          const product = state.productsById[o.productId];
          const platform = o.channel === "google" ? null : (o.channel as PlatformId);
          return (
            <li key={o.id} className="px-5 py-3">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                {platform ? <PlatformBadge platform={platform} /> : null}
                <span className="text-xs text-ink-500 capitalize">
                  {o.kind.replace(/_/g, " ")}
                </span>
                <span
                  className={`badge ${
                    o.impact === "high"
                      ? "bg-red-50 text-red-700"
                      : o.impact === "medium"
                        ? "bg-amber-50 text-amber-700"
                        : "bg-ink-100 text-ink-700"
                  }`}
                >
                  {o.impact} impact
                </span>
                <span className="text-xs text-ink-500">{product?.name}</span>
                {knownHooks.some((h) =>
                  h.toLowerCase().includes(o.title.slice(0, 24).toLowerCase()),
                ) ? (
                  <span className="badge bg-amber-50 text-amber-700 text-[10px]">
                    similar already in plan
                  </span>
                ) : null}
              </div>
              <div className="text-sm text-ink-900 font-medium">{o.title}</div>
              <p className="text-xs text-ink-700 mt-1">{o.rationale}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function GoogleOpportunityList({
  opportunities,
}: {
  opportunities: DiscoverabilityOpportunity[];
}) {
  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100">
        <div className="text-sm font-semibold text-ink-900">
          Google discoverability opportunities
        </div>
        <p className="text-xs text-ink-500 mt-0.5">
          Search-to-social, freshness, internal linking, and topic-cluster
          gaps surfaced from insights paired with content assets.
        </p>
      </header>
      <ul className="row-divider">
        {opportunities.map((o) => (
          <li key={o.id} className="px-5 py-3">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className="badge bg-ink-900 text-white">Google</span>
              <span className="text-xs text-ink-500 capitalize">
                {o.kind.replace(/_/g, " ")}
              </span>
              <span
                className={`badge ${impactTone(o.impact)}`}
              >
                {o.impact}
              </span>
            </div>
            <div className="text-sm text-ink-900 font-medium">{o.title}</div>
            <p className="text-xs text-ink-700 mt-1">{o.detail}</p>
            <p className="text-xs text-ink-800 mt-1 italic">{o.suggestedAction}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function impactTone(impact: OpportunityImpact): string {
  return impact === "high"
    ? "bg-red-50 text-red-700"
    : impact === "medium"
      ? "bg-amber-50 text-amber-700"
      : "bg-ink-100 text-ink-700";
}

function weightFor(impact: OpportunityImpact): number {
  return impact === "high" ? 3 : impact === "medium" ? 2 : 1;
}
