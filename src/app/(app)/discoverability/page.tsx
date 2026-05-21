"use client";

import Link from "next/link";
import { useMemo } from "react";
import { Topbar } from "@/components/topbar";
import { ChevronRightIcon } from "@/components/icons";
import { useSignal } from "@/core/store";
import {
  buildVisibilitySnapshot,
  calculateDiscoverabilityOpportunities,
} from "@/core/discoverability";
import { contentAssets } from "@/lib/mock";
import type {
  DiscoverabilityOpportunity,
  ProductProfile,
} from "@/types";

export default function DiscoverabilityPage() {
  const { state } = useSignal();
  const products = useMemo(
    () => Object.values(state.productsById),
    [state.productsById],
  );

  const opportunities = useMemo(
    () => calculateDiscoverabilityOpportunities(contentAssets, products),
    [products],
  );

  const high = opportunities.filter((o) => o.impact === "high");
  const medium = opportunities.filter((o) => o.impact === "medium");
  const low = opportunities.filter((o) => o.impact === "low");

  const visibility = useMemo(
    () =>
      products
        .map((p) => buildVisibilitySnapshot(p.id, contentAssets))
        .filter((s) => s.totalAssets > 0)
        .sort((a, b) => a.discoverabilityScore - b.discoverabilityScore),
    [products],
  );

  return (
    <>
      <Topbar
        title="Discoverability"
        description="Cross-channel visibility, freshness, and topical coverage. Signal&apos;s search-to-social and social-to-search lens."
      />

      <div className="px-6 lg:px-8 py-6 max-w-7xl space-y-6">
        <Intro />

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Total opportunities" value={opportunities.length} />
          <Stat label="High impact" value={high.length} tone="red" />
          <Stat label="Medium impact" value={medium.length} tone="amber" />
          <Stat label="Low impact" value={low.length} tone="ink" />
        </div>

        <SearchToSocial opportunities={opportunities} />
        <SocialToSearch opportunities={opportunities} />
        <TopicClusterGaps opportunities={opportunities} />
        <EvergreenList opportunities={opportunities} />
        <RefreshList opportunities={opportunities} />

        <VisibilityRanking snapshots={visibility} products={products} />

        <WebmasterIDPlaceholder />

        <BridgeCard />
      </div>
    </>
  );
}

function Intro() {
  return (
    <div className="card border-signal-200 bg-signal-50/30 p-4 text-sm leading-relaxed">
      <div className="font-semibold text-ink-900 mb-1">
        Search &amp; social, in one operational lens.
      </div>
      <p className="text-ink-700">
        Discoverability sits next to the social command centers, not inside
        them. The dashboard surfaces visibility gaps, refresh windows, and
        amplification opportunities derived from the local content list. Every
        suggestion is calm and reviewable — Signal does not publish, index, or
        update content automatically.
      </p>
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
  tone?: "red" | "amber" | "ink";
}) {
  const cls =
    tone === "red"
      ? "text-red-700"
      : tone === "amber"
        ? "text-amber-700"
        : tone === "ink"
          ? "text-ink-700"
          : "text-ink-900";
  return (
    <div className="card-padded">
      <div className="stat-label">{label}</div>
      <div className={`text-2xl font-semibold mt-1 ${cls}`}>{value}</div>
    </div>
  );
}

function SearchToSocial({
  opportunities,
}: {
  opportunities: DiscoverabilityOpportunity[];
}) {
  const filtered = opportunities.filter((o) => o.kind === "search_to_social");
  return (
    <OpportunitySection
      title="Search-to-social"
      hint="High search potential, low social distribution. Plan one calm cross-platform reference."
      items={filtered}
    />
  );
}

function SocialToSearch({
  opportunities,
}: {
  opportunities: DiscoverabilityOpportunity[];
}) {
  const filtered = opportunities.filter((o) => o.kind === "low_amplification");
  return (
    <OpportunitySection
      title="Social-to-search"
      hint="Recent content with no amplification yet. Add a single calm mention next week."
      items={filtered}
    />
  );
}

function TopicClusterGaps({
  opportunities,
}: {
  opportunities: DiscoverabilityOpportunity[];
}) {
  const filtered = opportunities.filter((o) => o.kind === "topic_cluster_gap");
  if (filtered.length === 0) return null;
  return (
    <OpportunitySection
      title="Topic cluster gaps"
      hint="Clusters that need a companion guide or case study."
      items={filtered}
    />
  );
}

function EvergreenList({
  opportunities,
}: {
  opportunities: DiscoverabilityOpportunity[];
}) {
  const filtered = opportunities.filter(
    (o) => o.kind === "evergreen_distribution",
  );
  if (filtered.length === 0) return null;
  return (
    <OpportunitySection
      title="Evergreen distribution"
      hint="Strong evergreen assets without recent amplification."
      items={filtered}
    />
  );
}

function RefreshList({
  opportunities,
}: {
  opportunities: DiscoverabilityOpportunity[];
}) {
  const filtered = opportunities.filter((o) => o.kind === "freshness_refresh");
  if (filtered.length === 0) return null;
  return (
    <OpportunitySection
      title="Refresh windows"
      hint="Recommended refresh suggestions surfaced calmly, not as deadlines."
      items={filtered}
    />
  );
}

function OpportunitySection({
  title,
  hint,
  items,
}: {
  title: string;
  hint: string;
  items: DiscoverabilityOpportunity[];
}) {
  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-ink-900">{title}</div>
          <p className="text-xs text-ink-500 mt-0.5">{hint}</p>
        </div>
        <span className="text-xs text-ink-500">{items.length}</span>
      </header>
      {items.length === 0 ? (
        <div className="px-5 py-4 text-sm text-ink-500">
          Nothing flagged in this category.
        </div>
      ) : (
        <ul className="row-divider">
          {items.map((o) => (
            <li key={o.id} className="px-5 py-3">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span
                  className={`badge ${
                    o.impact === "high"
                      ? "bg-red-50 text-red-700"
                      : o.impact === "medium"
                        ? "bg-amber-50 text-amber-700"
                        : "bg-ink-100 text-ink-700"
                  }`}
                >
                  {o.impact}
                </span>
                {o.cluster ? (
                  <span className="text-xs text-ink-500">{o.cluster}</span>
                ) : null}
              </div>
              <div className="text-sm font-medium text-ink-900">{o.title}</div>
              <p className="text-xs text-ink-700 mt-1">{o.detail}</p>
              <p className="text-xs text-ink-800 mt-1 italic">{o.suggestedAction}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function VisibilityRanking({
  snapshots,
  products,
}: {
  snapshots: ReturnType<typeof buildVisibilitySnapshot>[];
  products: ProductProfile[];
}) {
  if (snapshots.length === 0) return null;
  const productsById = Object.fromEntries(products.map((p) => [p.id, p]));
  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100">
        <div className="text-sm font-semibold text-ink-900">
          Visibility by product
        </div>
        <p className="text-xs text-ink-500 mt-0.5">
          Composite discoverability score across the portfolio.
        </p>
      </header>
      <ul className="row-divider">
        {snapshots.map((snap) => {
          const product = productsById[snap.productId];
          return (
            <li key={snap.productId} className="px-5 py-3">
              <div className="flex items-center justify-between gap-2 mb-1">
                <div>
                  <div className="text-sm font-medium text-ink-900">
                    {product?.name}
                  </div>
                  <div className="text-xs text-ink-500">{product?.domain}</div>
                </div>
                <div className="text-right">
                  <div
                    className={`text-sm font-semibold ${
                      snap.discoverabilityScore < 40
                        ? "text-red-700"
                        : snap.discoverabilityScore < 70
                          ? "text-amber-700"
                          : "text-emerald-700"
                    }`}
                  >
                    {snap.discoverabilityScore}
                  </div>
                  <div className="text-[11px] text-ink-500">score</div>
                </div>
              </div>
              <div className="h-1.5 bg-ink-100 rounded-full overflow-hidden">
                <div
                  className={`h-full ${
                    snap.discoverabilityScore < 40
                      ? "bg-red-500"
                      : snap.discoverabilityScore < 70
                        ? "bg-amber-500"
                        : "bg-emerald-500"
                  }`}
                  style={{ width: `${snap.discoverabilityScore}%` }}
                />
              </div>
              <div className="text-[11px] text-ink-500 mt-1.5">
                {snap.totalAssets} asset{snap.totalAssets === 1 ? "" : "s"} ·{" "}
                {snap.freshAssets} fresh · {snap.staleAssets} stale ·{" "}
                {snap.evergreenAssets} evergreen
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function WebmasterIDPlaceholder() {
  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-ink-900">
            WebmasterID discoverability layer
          </div>
          <p className="text-xs text-ink-500 mt-0.5">
            Reserved for live signals.
          </p>
        </div>
        <span className="badge bg-ink-100 text-ink-500">
          Data not yet connected
        </span>
      </header>
      <ul className="row-divider text-sm text-ink-700">
        {[
          "Live search impressions",
          "Per-asset traffic by source",
          "Funnel-level distribution gaps",
          "Topical demand signals",
        ].map((label) => (
          <li key={label} className="px-5 py-2.5 flex items-center justify-between">
            <span>{label}</span>
            <span className="text-xs text-ink-500">Data not yet connected</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function BridgeCard() {
  return (
    <section className="card">
      <div className="p-5">
        <div className="text-sm font-semibold text-ink-900 mb-1">
          Bridge into the rest of Signal
        </div>
        <p className="text-xs text-ink-700 mb-3 leading-relaxed">
          Discoverability is one half of the loop. Approved social activity
          travels through the weekly plan and the platform command centers.
        </p>
        <div className="flex flex-wrap gap-2">
          <Link href="/platforms/google" className="btn">
            Google visibility center
            <ChevronRightIcon className="ml-1" width={12} height={12} />
          </Link>
          <Link href="/weekly-plan" className="btn">
            Weekly plan
            <ChevronRightIcon className="ml-1" width={12} height={12} />
          </Link>
          <Link href="/platforms" className="btn">
            Platforms overview
            <ChevronRightIcon className="ml-1" width={12} height={12} />
          </Link>
        </div>
      </div>
    </section>
  );
}

