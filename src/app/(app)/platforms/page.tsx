"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { PlatformBadge } from "@/components/badges";
import { ChevronRightIcon } from "@/components/icons";
import { useSignal } from "@/core/store";
import {
  calculatePlatformCadenceLoad,
  calculatePlatformReadiness,
  getPlatformCadencePolicy,
  getPlatformRecommendations,
  getPlatformStrategy,
} from "@/core/platforms";
import {
  buildVisibilitySnapshot,
  calculateDiscoverabilityOpportunities,
  calculateFreshnessStatus,
} from "@/core/discoverability";
import { contentAssets, platforms as platformList } from "@/lib/mock";
import type { PlatformId } from "@/types";

const platformIds: PlatformId[] = ["reddit", "x", "linkedin"];

export default function PlatformsOverview() {
  const { state } = useSignal();
  const accounts = useMemo(
    () => Object.values(state.accountsById),
    [state.accountsById],
  );

  return (
    <>
      <Topbar
        title="Platform command centers"
        description="One operational core, four platform-native lenses. Three social surfaces plus a search & discoverability layer."
      />

      <div className="px-6 lg:px-8 py-6 max-w-7xl space-y-6">
        <Intro />

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {platformIds.map((id) => {
            const readiness = calculatePlatformReadiness(id, accounts);
            const load = calculatePlatformCadenceLoad(id, state.items);
            const cadence = getPlatformCadencePolicy(id);
            const strategy = getPlatformStrategy(id);
            const items = state.items.filter((i) => i.platform === id);
            const blocked = items.filter((i) => i.risk.level === "blocked").length;
            const high = items.filter((i) => i.risk.level === "high").length;
            const medium = items.filter((i) => i.risk.level === "medium").length;
            const recs = getPlatformRecommendations({
              platform: id,
              accounts,
              items: state.items,
              backlog: state.backlog,
            });
            const topRec = recs[0];
            const platform = platformList.find((p) => p.id === id);
            return (
              <Link
                key={id}
                href={`/platforms/${id}`}
                className="card hover:border-signal-300 hover:shadow transition-all p-5 group"
              >
                <div className="flex items-center justify-between mb-2">
                  <PlatformBadge platform={id} />
                  <span className="text-xs text-ink-500">
                    {cadence.cadenceMode} cadence
                  </span>
                </div>
                <div className="text-base font-semibold text-ink-900 mb-1">
                  {strategy.strategicRole}
                </div>
                <p className="text-xs text-ink-600 leading-snug line-clamp-3 mb-3">
                  {strategy.shortDescription}
                </p>

                <div className="grid grid-cols-3 gap-2 mb-3">
                  <Mini
                    label="Readiness"
                    value={`${readiness.overallScore}%`}
                  />
                  <Mini
                    label="Accounts"
                    value={`${readiness.accountsEligible}/${readiness.accountsTotal}`}
                  />
                  <Mini
                    label="Cadence"
                    value={`${load.count}/${cadence.suggestedPostsPerWeek}`}
                    warn={load.isOver}
                  />
                </div>

                <div className="grid grid-cols-2 gap-2 mb-3">
                  <Mini label="Scheduled" value={`${items.length}`} />
                  <Mini
                    label="Risk"
                    value={`${blocked + high}`}
                    sub={`${medium} medium`}
                    warn={blocked + high > 0}
                  />
                </div>

                {topRec ? (
                  <div
                    className={`text-xs rounded-md px-3 py-2 ${
                      topRec.level === "block"
                        ? "bg-red-50 text-ink-900"
                        : topRec.level === "warn"
                          ? "bg-amber-50 text-ink-800"
                          : "bg-signal-50/60 text-ink-800"
                    }`}
                  >
                    <div className="stat-label mb-0.5">Next action</div>
                    <div className="leading-snug">{topRec.text}</div>
                  </div>
                ) : null}

                <div className="text-xs text-signal-700 font-medium mt-3 inline-flex items-center gap-1 group-hover:text-signal-800">
                  Open command center
                  <ChevronRightIcon width={12} height={12} />
                </div>

                {platform ? (
                  <div className="text-[11px] text-ink-500 mt-2">
                    {platform.notes[0]}
                  </div>
                ) : null}
              </Link>
            );
          })}
          <GoogleCard />
        </div>

        <ComparisonTable />
      </div>
    </>
  );
}

function GoogleCard() {
  const { state } = useSignal();
  const products = Object.values(state.productsById);
  const visibility =
    products.length === 0
      ? 0
      : Math.round(
          products
            .map((p) => buildVisibilitySnapshot(p.id, contentAssets).discoverabilityScore)
            .reduce((a, b) => a + b, 0) / products.length,
        );
  const opportunities = calculateDiscoverabilityOpportunities(
    contentAssets,
    products,
  );
  const high = opportunities.filter((o) => o.impact === "high").length;
  const medium = opportunities.filter((o) => o.impact === "medium").length;
  const fresh = contentAssets.filter(
    (a) => calculateFreshnessStatus(a).status === "fresh",
  ).length;
  const stale = contentAssets.filter(
    (a) => calculateFreshnessStatus(a).status === "stale",
  ).length;
  const evergreen = contentAssets.filter(
    (a) => calculateFreshnessStatus(a).status === "evergreen",
  ).length;
  const topRec = opportunities[0];
  return (
    <Link
      href="/platforms/google"
      className="card hover:border-signal-300 hover:shadow transition-all p-5 group"
    >
      <div className="flex items-center justify-between mb-2">
        <span className="badge bg-ink-900 text-white">Google</span>
        <span className="text-xs text-ink-500">discoverability</span>
      </div>
      <div className="text-base font-semibold text-ink-900 mb-1">
        Search &amp; discoverability operations
      </div>
      <p className="text-xs text-ink-600 leading-snug line-clamp-3 mb-3">
        Not a publishing platform. Visibility, content freshness, topical
        coverage, and YouTube planning sit here.
      </p>

      <div className="grid grid-cols-3 gap-2 mb-3">
        <Mini label="Discoverability" value={`${visibility}%`} />
        <Mini label="Assets" value={`${contentAssets.length}`} />
        <Mini
          label="Opportunities"
          value={`${high + medium}`}
          warn={high > 0}
        />
      </div>
      <div className="grid grid-cols-3 gap-2 mb-3">
        <Mini label="Fresh" value={`${fresh}`} />
        <Mini label="Evergreen" value={`${evergreen}`} />
        <Mini label="Stale" value={`${stale}`} warn={stale > 0} />
      </div>

      {topRec ? (
        <div
          className={`text-xs rounded-md px-3 py-2 ${
            topRec.impact === "high"
              ? "bg-red-50 text-ink-900"
              : topRec.impact === "medium"
                ? "bg-amber-50 text-ink-800"
                : "bg-signal-50/60 text-ink-800"
          }`}
        >
          <div className="stat-label mb-0.5">Top opportunity</div>
          <div className="leading-snug">{topRec.title}</div>
        </div>
      ) : null}

      <div className="text-xs text-signal-700 font-medium mt-3 inline-flex items-center gap-1 group-hover:text-signal-800">
        Open command center
        <ChevronRightIcon width={12} height={12} />
      </div>
      <div className="text-[11px] text-ink-500 mt-2">
        Google is treated as a discoverability surface, not a publishing one.
      </div>
    </Link>
  );
}

function Intro() {
  return (
    <div className="card border-signal-200 bg-signal-50/30 p-4 text-sm leading-relaxed">
      <div className="font-semibold text-ink-900 mb-1">
        One operational core. Four platform-native lenses.
      </div>
      <p className="text-ink-700">
        Signal&apos;s weekly planner, approval queue, scheduler, risk engine,
        and backlog stay shared. Three social command centers (Reddit, X,
        LinkedIn) apply platform-specific strategy. A fourth lens — Google —
        runs as search &amp; discoverability operations, not as a publishing
        platform. Signal does not become a generic universal dashboard; each
        surface is treated on its own terms.
      </p>
    </div>
  );
}

function Mini({
  label,
  value,
  sub,
  warn,
}: {
  label: string;
  value: string;
  sub?: string;
  warn?: boolean;
}) {
  return (
    <div className="rounded-md bg-ink-50/70 px-2.5 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-ink-500 font-semibold">
        {label}
      </div>
      <div
        className={`text-sm font-semibold ${warn ? "text-amber-700" : "text-ink-900"}`}
      >
        {value}
      </div>
      {sub ? <div className="text-[10px] text-ink-500">{sub}</div> : null}
    </div>
  );
}

function ComparisonTable() {
  return (
    <section className="card overflow-x-auto">
      <header className="px-5 py-3.5 border-b border-ink-100">
        <div className="text-sm font-semibold text-ink-900">
          How the platforms differ
        </div>
        <p className="text-xs text-ink-500 mt-0.5">
          Strategic role, voice, cadence, and Google&apos;s separate
          discoverability nature at a glance.
        </p>
      </header>
      <table className="w-full text-sm">
        <thead className="bg-ink-50 text-ink-500 text-xs uppercase tracking-wide">
          <tr>
            <th className="text-left px-4 py-2.5">Dimension</th>
            <th className="text-left px-4 py-2.5">Reddit</th>
            <th className="text-left px-4 py-2.5">X</th>
            <th className="text-left px-4 py-2.5">LinkedIn</th>
            <th className="text-left px-4 py-2.5">Google</th>
          </tr>
        </thead>
        <tbody className="row-divider">
          <Row
            label="Surface type"
            values={["Social", "Social", "Social", "Search / discoverability"]}
          />
          <Row
            label="Strategic role"
            values={[
              "Community depth",
              "Founder voice",
              "B2B trust",
              "Visibility & freshness",
            ]}
          />
          <Row
            label="Voice"
            values={[
              "Calm, community-native",
              "Sharp, founder-native",
              "Professional, restrained",
              "n/a — content layer",
            ]}
          />
          <Row
            label="Cadence shape"
            values={[
              "2/week suggested",
              "7/week suggested",
              "3/week suggested",
              "Refresh windows, not cadence",
            ]}
          />
          <Row
            label="Cooldown"
            values={[
              "36h per account",
              "6h per account",
              "24h per account",
              "Per-asset refresh window",
            ]}
          />
          <Row
            label="Link tolerance"
            values={["Very low", "Low", "Medium", "Internal links matter"]}
          />
          <Row
            label="Gate emphasis"
            values={[
              "Direct-link risk",
              "Hook repetition + bursts",
              "Polish + credibility",
              "Discoverability opportunities",
            ]}
          />
        </tbody>
      </table>
    </section>
  );
}

function Row({
  label,
  values,
}: {
  label: string;
  values: [string, string, string, string];
}) {
  return (
    <tr>
      <td className="px-4 py-2.5 text-ink-700 font-medium">{label}</td>
      <td className="px-4 py-2.5 text-ink-800">{values[0]}</td>
      <td className="px-4 py-2.5 text-ink-800">{values[1]}</td>
      <td className="px-4 py-2.5 text-ink-800">{values[2]}</td>
      <td className="px-4 py-2.5 text-ink-800">{values[3]}</td>
    </tr>
  );
}
