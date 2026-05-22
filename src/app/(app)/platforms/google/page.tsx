"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { ChevronRightIcon, LockIcon } from "@/components/icons";
import { useSignal } from "@/core/store";
import {
  buildVisibilitySnapshot,
  buildTopicalClusters,
  buildYouTubeCadencePlan,
  buildYouTubeIdeas,
  calculateDiscoverabilityOpportunities,
  calculateFreshnessStatus,
} from "@/core/discoverability";
import { contentAssets as allContentAssets } from "@/lib/mock";
import { useDemoData } from "@/lib/demo-data";
import type {
  ContentAsset,
  DiscoverabilityOpportunity,
  FreshnessStatus,
  ProductProfile,
  YouTubeFormatKind,
} from "@/types";

const freshnessLabels: Record<FreshnessStatus, string> = {
  fresh: "Fresh",
  evergreen: "Evergreen",
  needs_refresh: "Needs refresh",
  stale: "Stale",
  under_promoted: "Under-promoted",
};

const freshnessTones: Record<FreshnessStatus, string> = {
  fresh: "bg-emerald-50 text-emerald-700",
  evergreen: "bg-signal-50 text-signal-700",
  needs_refresh: "bg-amber-50 text-amber-700",
  stale: "bg-red-50 text-red-700",
  under_promoted: "bg-ink-100 text-ink-700",
};

const youtubeKindLabels: Record<YouTubeFormatKind, string> = {
  shorts: "Shorts",
  founder_video: "Founder video",
  community_update: "Community update",
  long_form: "Long-form",
};

export default function GoogleVisibilityCommandCenter() {
  const { state } = useSignal();
  const products = useMemo(
    () => Object.values(state.productsById),
    [state.productsById],
  );

  const contentAssets = useDemoData(allContentAssets);
  const assets = useMemo(
    () =>
      contentAssets.map((a) => ({
        ...a,
        freshness: calculateFreshnessStatus(a).status,
      })),
    [contentAssets],
  );

  const aggregate = useMemo(() => {
    const totals = {
      total: assets.length,
      indexed: 0,
      fresh: 0,
      evergreen: 0,
      needs_refresh: 0,
      stale: 0,
      under_promoted: 0,
    };
    for (const a of assets) {
      if (a.indexed) totals.indexed++;
      totals[a.freshness]++;
    }
    return totals;
  }, [assets]);

  const opportunities = useMemo(
    () => calculateDiscoverabilityOpportunities(assets, products),
    [assets, products],
  );

  const score = useMemo(() => {
    if (products.length === 0) return 0;
    const sum = products
      .map((p) => buildVisibilitySnapshot(p.id, assets).discoverabilityScore)
      .reduce((a, b) => a + b, 0);
    return Math.round(sum / products.length);
  }, [assets, products]);

  return (
    <>
      <Topbar
        title="Google visibility — search &amp; discoverability operations"
        description="Not a publishing platform. Signal does not auto-index, auto-update, or auto-publish."
      />

      <div className="px-6 lg:px-8 py-6 max-w-7xl space-y-6">
        <Intro />

        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <Stat label="Discoverability" value={`${score}%`} sub="composite" />
          <Stat label="Indexed" value={`${aggregate.indexed}/${aggregate.total}`} sub="mock" />
          <Stat label="Fresh" value={`${aggregate.fresh}`} tone="emerald" />
          <Stat label="Evergreen" value={`${aggregate.evergreen}`} tone="signal" />
          <Stat label="Needs refresh" value={`${aggregate.needs_refresh}`} tone="amber" />
          <Stat
            label="Stale"
            value={`${aggregate.stale}`}
            tone={aggregate.stale > 0 ? "red" : undefined}
          />
        </div>

        <RecommendedActions opportunities={opportunities} />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <SearchVisibility assets={assets} products={products} />
            <ContentFreshness assets={assets} />
            <DiscoverabilitySignals opportunities={opportunities} />
            <TopicalCoverage assets={assets} products={products} />
            <InternalLinking assets={assets} />
            <EvergreenContent assets={assets} />
            <UnderPromoted assets={assets} />
            <PublishingFreshness assets={assets} />
          </div>
          <div className="space-y-6">
            <YouTubeEcosystem products={products} />
            <WebmasterIDPlaceholder />
            <OAuthFutureCard />
          </div>
        </div>
      </div>
    </>
  );
}

function Intro() {
  return (
    <div className="card border-signal-200 bg-signal-50/30 p-4 text-sm leading-relaxed">
      <div className="font-semibold text-ink-900 mb-1">
        Search &amp; discoverability operations
      </div>
      <p className="text-ink-700">
        Google is not a social publishing surface. This command center is the
        operational layer for visibility, content freshness, topical coverage,
        and YouTube planning. No Search Console API, no indexing API, no
        automated publishing — every signal here is mock or derived from the
        local content list. Real data arrives when WebmasterID is connected.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "emerald" | "signal" | "amber" | "red";
}) {
  const cls =
    tone === "emerald"
      ? "text-emerald-700"
      : tone === "signal"
        ? "text-signal-700"
        : tone === "amber"
          ? "text-amber-700"
          : tone === "red"
            ? "text-red-700"
            : "text-ink-900";
  return (
    <div className="card-padded">
      <div className="stat-label">{label}</div>
      <div className={`text-xl font-semibold mt-1 ${cls}`}>{value}</div>
      {sub ? <div className="text-[11px] text-ink-500 mt-0.5">{sub}</div> : null}
    </div>
  );
}

function RecommendedActions({
  opportunities,
}: {
  opportunities: DiscoverabilityOpportunity[];
}) {
  const top = opportunities.slice(0, 3);
  if (top.length === 0) return null;
  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100">
        <div className="text-sm font-semibold text-ink-900">
          Recommended next actions
        </div>
        <p className="text-xs text-ink-500 mt-0.5">
          Top discoverability opportunities derived from the current content
          list. Nothing is published automatically.
        </p>
      </header>
      <ul className="row-divider">
        {top.map((o) => (
          <li key={o.id} className="px-5 py-3.5">
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
                {o.impact} impact
              </span>
              <span className="text-xs text-ink-500 uppercase tracking-wide">
                {o.kind.replace(/_/g, " ")}
              </span>
            </div>
            <div className="text-sm font-medium text-ink-900">{o.title}</div>
            <p className="text-xs text-ink-700 mt-1">{o.detail}</p>
            <p className="text-xs text-ink-800 mt-1 italic">{o.suggestedAction}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SearchVisibility({
  assets,
  products,
}: {
  assets: ContentAsset[];
  products: ProductProfile[];
}) {
  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100">
        <div className="text-sm font-semibold text-ink-900">Search visibility</div>
        <p className="text-xs text-ink-500 mt-0.5">
          Mock per-product snapshot. Live numbers appear once WebmasterID is wired.
        </p>
      </header>
      <ul className="row-divider">
        {products.map((p) => {
          const snap = buildVisibilitySnapshot(p.id, assets);
          if (snap.totalAssets === 0) return null;
          return (
            <li key={p.id} className="px-5 py-3">
              <div className="flex items-center justify-between mb-1.5 flex-wrap gap-2">
                <div>
                  <div className="text-sm font-medium text-ink-900">{p.name}</div>
                  <div className="text-xs text-ink-500">{p.domain}</div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-semibold text-ink-900">
                    {snap.discoverabilityScore}
                  </div>
                  <div className="text-[11px] text-ink-500">score</div>
                </div>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                <Mini label="Indexed" value={`${snap.indexedAssets}/${snap.totalAssets}`} />
                <Mini label="Fresh" value={snap.freshAssets} />
                <Mini label="Evergreen" value={snap.evergreenAssets} />
                <Mini label="Stale" value={snap.staleAssets} tone={snap.staleAssets > 0 ? "amber" : undefined} />
                <Mini
                  label="Avg position"
                  value={snap.averagePosition === null ? "—" : snap.averagePosition.toFixed(1)}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Mini({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: "amber";
}) {
  const cls = tone === "amber" ? "text-amber-700" : "text-ink-900";
  return (
    <div className="rounded-md bg-ink-50/70 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-ink-500 font-semibold">
        {label}
      </div>
      <div className={`text-sm font-semibold ${cls}`}>{value}</div>
    </div>
  );
}

function ContentFreshness({ assets }: { assets: ContentAsset[] }) {
  const rows = useMemo(() => [...assets].slice().sort(byFreshness), [assets]);
  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100">
        <div className="text-sm font-semibold text-ink-900">Content freshness</div>
        <p className="text-xs text-ink-500 mt-0.5">
          Every asset is scored against the freshness window. Refresh windows
          are suggested calmly — not as deadlines.
        </p>
      </header>
      <ul className="row-divider">
        {rows.map((a) => {
          const verdict = calculateFreshnessStatus(a);
          return (
            <li key={a.id} className="px-5 py-3">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className={`badge ${freshnessTones[verdict.status]}`}>
                  {freshnessLabels[verdict.status]}
                </span>
                <span className="text-xs text-ink-500">
                  {verdict.ageDays}d since update
                </span>
                {verdict.suggestedRefreshWindowDays ? (
                  <span className="text-xs text-ink-500">
                    · refresh window {verdict.suggestedRefreshWindowDays}d
                  </span>
                ) : null}
              </div>
              <div className="text-sm font-medium text-ink-900">{a.title}</div>
              <div className="text-xs text-ink-500 mt-0.5 font-mono">{a.url}</div>
              <div className="text-xs text-ink-700 mt-1">{verdict.reason}</div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function byFreshness(a: ContentAsset, b: ContentAsset): number {
  const order: FreshnessStatus[] = [
    "stale",
    "needs_refresh",
    "under_promoted",
    "fresh",
    "evergreen",
  ];
  return order.indexOf(a.freshness) - order.indexOf(b.freshness);
}

function DiscoverabilitySignals({
  opportunities,
}: {
  opportunities: DiscoverabilityOpportunity[];
}) {
  if (opportunities.length === 0) return null;
  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100">
        <div className="text-sm font-semibold text-ink-900">
          Discoverability signals
        </div>
        <p className="text-xs text-ink-500 mt-0.5">
          {opportunities.length} live signal{opportunities.length === 1 ? "" : "s"} derived from the content list.
        </p>
      </header>
      <ul className="row-divider">
        {opportunities.map((o) => (
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
              <span className="text-xs text-ink-500 uppercase tracking-wide">
                {o.kind.replace(/_/g, " ")}
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

function TopicalCoverage({
  assets,
  products,
}: {
  assets: ContentAsset[];
  products: ProductProfile[];
}) {
  const all = products.flatMap((p) => buildTopicalClusters(p.id, assets));
  if (all.length === 0) return null;
  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100">
        <div className="text-sm font-semibold text-ink-900">Topical coverage</div>
        <p className="text-xs text-ink-500 mt-0.5">
          Clusters across products. Thin coverage is surfaced as an opportunity.
        </p>
      </header>
      <ul className="grid grid-cols-1 md:grid-cols-2 gap-2 p-3">
        {all.map((c) => (
          <li
            key={c.id}
            className={`rounded-md border p-3 ${
              c.coverageGap === "thin"
                ? "border-amber-200 bg-amber-50/30"
                : c.coverageGap === "missing"
                  ? "border-red-200 bg-red-50/30"
                  : "border-ink-100 bg-white"
            }`}
          >
            <div className="text-sm font-semibold text-ink-900 mb-1">
              {c.label}
            </div>
            <div className="text-xs text-ink-700">{c.note}</div>
            <div className="text-[11px] text-ink-500 mt-1">
              {c.assetCount} asset{c.assetCount === 1 ? "" : "s"} ·{" "}
              freshness {c.averageFreshnessScore}%
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function InternalLinking({ assets }: { assets: ContentAsset[] }) {
  const isolated = assets.filter((a) => a.internalLinks.incoming === 0);
  if (isolated.length === 0) return null;
  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100">
        <div className="text-sm font-semibold text-ink-900">
          Internal linking opportunities
        </div>
        <p className="text-xs text-ink-500 mt-0.5">
          Assets with no incoming internal links. Add two contextual links from
          the same cluster.
        </p>
      </header>
      <ul className="row-divider">
        {isolated.map((a) => (
          <li key={a.id} className="px-5 py-3">
            <div className="text-sm font-medium text-ink-900">{a.title}</div>
            <div className="text-xs text-ink-500 mt-0.5 font-mono">{a.url}</div>
            <div className="text-xs text-ink-700 mt-1">
              Cluster: {a.cluster} · outgoing links: {a.internalLinks.outgoing}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function EvergreenContent({ assets }: { assets: ContentAsset[] }) {
  const evergreen = assets.filter((a) => calculateFreshnessStatus(a).status === "evergreen");
  if (evergreen.length === 0) return null;
  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100">
        <div className="text-sm font-semibold text-ink-900">Evergreen content</div>
        <p className="text-xs text-ink-500 mt-0.5">
          Assets that hold position over time. Strong candidates for periodic
          calm distribution.
        </p>
      </header>
      <ul className="row-divider">
        {evergreen.map((a) => (
          <li key={a.id} className="px-5 py-3">
            <div className="text-sm font-medium text-ink-900">{a.title}</div>
            <div className="text-xs text-ink-500 mt-0.5 font-mono">{a.url}</div>
            <div className="text-xs text-ink-700 mt-1">{a.summary}</div>
            <div className="text-[11px] text-ink-500 mt-1">
              Incoming links: {a.internalLinks.incoming} · Mock position:{" "}
              {a.mockSearchPosition ?? "—"}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function UnderPromoted({ assets }: { assets: ContentAsset[] }) {
  const under = assets.filter((a) => calculateFreshnessStatus(a).status === "under_promoted");
  if (under.length === 0) return null;
  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100">
        <div className="text-sm font-semibold text-ink-900">
          Under-promoted content
        </div>
        <p className="text-xs text-ink-500 mt-0.5">
          Recent assets with no social amplification yet. Plan one calm reference.
        </p>
      </header>
      <ul className="row-divider">
        {under.map((a) => (
          <li key={a.id} className="px-5 py-3">
            <div className="text-sm font-medium text-ink-900">{a.title}</div>
            <div className="text-xs text-ink-500 mt-0.5 font-mono">{a.url}</div>
            <div className="text-xs text-ink-700 mt-1">{a.summary}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PublishingFreshness({ assets }: { assets: ContentAsset[] }) {
  const lastUpdate = assets
    .map((a) => new Date(a.updatedAt).getTime())
    .sort((a, b) => b - a)[0];
  const daysSince = lastUpdate
    ? Math.floor((Date.now() - lastUpdate) / (24 * 60 * 60 * 1000))
    : null;
  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100">
        <div className="text-sm font-semibold text-ink-900">
          Publishing freshness
        </div>
        <p className="text-xs text-ink-500 mt-0.5">
          Time since the most recent content update across all products.
        </p>
      </header>
      <div className="px-5 py-4 text-sm">
        {daysSince === null ? (
          <p className="text-ink-500">No content yet.</p>
        ) : (
          <p className="text-ink-800">
            <span className="font-semibold">{daysSince}</span> day
            {daysSince === 1 ? "" : "s"} since the most recent update across the
            portfolio.
          </p>
        )}
      </div>
    </section>
  );
}

function YouTubeEcosystem({ products }: { products: ProductProfile[] }) {
  if (products.length === 0) return null;
  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100">
        <div className="text-sm font-semibold text-ink-900">
          YouTube ecosystem
        </div>
        <p className="text-xs text-ink-500 mt-0.5">
          Planning only. No API. No upload. No publishing wired.
        </p>
      </header>
      <ul className="row-divider">
        {products.slice(0, 4).map((p) => {
          const ideas = buildYouTubeIdeas(p).slice(0, 3);
          const plan = buildYouTubeCadencePlan(p);
          return (
            <li key={p.id} className="px-5 py-3">
              <div className="text-sm font-medium text-ink-900 mb-1">{p.name}</div>
              <div className="text-[11px] text-ink-500 mb-2">
                Target: {plan.weeklyTarget}/week ·{" "}
                {plan.formats.map((f) => youtubeKindLabels[f]).join(" + ")}
              </div>
              <ul className="space-y-1.5">
                {ideas.map((idea) => (
                  <li key={idea.id} className="text-xs text-ink-800">
                    <span className="badge-neutral text-[10px] mr-1.5">
                      {youtubeKindLabels[idea.kind]}
                    </span>
                    {idea.title}
                  </li>
                ))}
              </ul>
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
            WebmasterID discoverability insights
          </div>
          <p className="text-xs text-ink-500 mt-0.5">
            Reserved slots for live signals.
          </p>
        </div>
        <span className="badge bg-ink-100 text-ink-500">
          Data not yet connected
        </span>
      </header>
      <ul className="row-divider text-sm text-ink-700">
        {[
          "Discoverability signals",
          "Visibility insights",
          "Traffic intelligence",
          "Content opportunity detection",
          "Distribution gaps",
        ].map((label) => (
          <li
            key={label}
            className="px-5 py-2.5 flex items-center justify-between"
          >
            <span>{label}</span>
            <span className="text-xs text-ink-500">Data not yet connected</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function OAuthFutureCard() {
  return (
    <section className="card border-signal-200 bg-signal-50/40">
      <div className="p-4 flex items-start gap-3 text-sm">
        <LockIcon className="text-signal-700 mt-0.5" />
        <div>
          <div className="font-semibold text-ink-900">
            Search Console / YouTube — not yet enabled
          </div>
          <p className="text-ink-700 mt-0.5 leading-relaxed">
            Signal will never ask for your Google password, cookies, session
            tokens, or recovery codes. When official Google integrations ship,
            they will go through OAuth. No automated indexing, no automated
            publishing.
          </p>
          <Link
            href="/discoverability"
            className="text-xs font-medium text-signal-700 hover:text-signal-800 inline-flex items-center gap-1 mt-3"
          >
            Open discoverability dashboard
            <ChevronRightIcon width={12} height={12} />
          </Link>
        </div>
      </div>
    </section>
  );
}
